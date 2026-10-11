import { and, asc, between, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { db, type Tx } from "@/db";
import {
  attendances,
  classTeachers,
  classes,
  enrollments,
  holidays,
  rooms,
  scheduleTemplates,
  sessionStudents,
  sessions,
  starLogs,
  teachers,
  timeSlots,
} from "@/db/schema";
import {
  type BusySession,
  describeConflict,
  findConflicts,
  isEnrolledOn,
  planSessions,
  staffOf,
} from "@/domain/schedule";
import { WEEKDAY_LABELS } from "@/lib/dates";
import { formatDate, todayIso } from "@/lib/format";
import type {
  makeupInput,
  manualSessionInput,
  sessionCancelInput,
  sessionEditInput,
  sessionRescheduleInput,
  sessionSubstituteInput,
  templateInput,
  templateUpdateInput,
} from "@/lib/validation/schedule";
import { audit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, allowedClassIds, assertAdmin, assertCan, assertCanAny, assertClassAccess, assertSessionAccess } from "../guard";
import { purgeSessionStarLogs } from "./stars";

const substitute = alias(teachers, "substitute");
const assistant = alias(teachers, "assistant");

const sessionColumns = {
  id: sessions.id,
  classId: sessions.classId,
  classCode: classes.code,
  className: classes.name,
  classStatus: classes.status,
  timetableOnly: classes.timetableOnly,
  date: sessions.date,
  originalDate: sessions.originalDate,
  startTime: sessions.startTime,
  endTime: sessions.endTime,
  timeSlotId: sessions.timeSlotId,
  slotName: timeSlots.name,
  roomId: sessions.roomId,
  roomName: rooms.name,
  teacherId: sessions.teacherId,
  teacherName: teachers.fullName,
  teacherShortName: teachers.shortName,
  substituteTeacherId: sessions.substituteTeacherId,
  substituteName: substitute.fullName,
  substituteShortName: substitute.shortName,
  assistantTeacherId: sessions.assistantTeacherId,
  assistantName: assistant.fullName,
  assistantShortName: assistant.shortName,
  kind: sessions.kind,
  status: sessions.status,
  content: sessions.content,
  teacherRemark: sessions.teacherRemark,
  note: sessions.note,
  attendanceUnlockedUntil: sessions.attendanceUnlockedUntil,
  attendanceCount: sql<number>`(select count(*)::int from ${attendances} where ${attendances.sessionId} = ${sessions.id})`,
  starLogCount: sql<number>`(select count(*)::int from ${starLogs} where ${starLogs.sessionId} = ${sessions.id})`,
};

function sessionQuery() {
  return db
    .select(sessionColumns)
    .from(sessions)
    .innerJoin(classes, eq(classes.id, sessions.classId))
    .leftJoin(timeSlots, eq(timeSlots.id, sessions.timeSlotId))
    .leftJoin(rooms, eq(rooms.id, sessions.roomId))
    .leftJoin(teachers, eq(teachers.id, sessions.teacherId))
    .leftJoin(substitute, eq(substitute.id, sessions.substituteTeacherId))
    .leftJoin(assistant, eq(assistant.id, sessions.assistantTeacherId));
}

/** Buổi mà GV này đứng lớp: dạy chính, dạy thay hoặc trợ giảng. */
const taughtBy = (teacherId: string) =>
  or(eq(sessions.teacherId, teacherId), eq(sessions.substituteTeacherId, teacherId), eq(sessions.assistantTeacherId, teacherId))!;

export type SessionRow = Awaited<ReturnType<typeof sessionQuery>>[number];

export type SessionFilters = {
  from: string;
  to: string;
  classId?: string | null;
  teacherId?: string | null;
  roomId?: string | null;
  /** Chỉ các buổi GV này đứng lớp hoặc dạy thay (TKB cá nhân). */
  personal?: boolean;
  /** Lấy cả buổi của lớp "chỉ hiển thị trên Thời khóa biểu". Chỉ trang Thời khóa biểu bật; nơi khác (điểm danh, tệp xuất…) bỏ qua các buổi này. */
  includeTimetableOnly?: boolean;
};

/** Admin và phạm vi "Tất cả lớp" xem mọi buổi; phạm vi "lớp của mình" chỉ thấy buổi của lớp mình và buổi mình dạy/dạy thay. */
export async function listSessions(actor: Actor, filters: SessionFilters): Promise<SessionRow[]> {
  const conditions = [between(sessions.date, filters.from, filters.to)];
  if (!filters.includeTimetableOnly) conditions.push(eq(classes.timetableOnly, false));
  if (filters.classId) conditions.push(eq(sessions.classId, filters.classId));
  if (filters.roomId) conditions.push(eq(sessions.roomId, filters.roomId));
  if (filters.teacherId) {
    conditions.push(taughtBy(filters.teacherId));
  }

  const allowed = await allowedClassIds(actor);
  const mine = actor.teacherId ? taughtBy(actor.teacherId) : null;
  if (allowed !== null) {
    // Phạm vi "lớp của mình": buổi mình dạy/dạy thay, cộng các buổi của lớp được phân công.
    if (!mine) return [];
    conditions.push(filters.personal || allowed.length === 0 ? mine : or(mine, inArray(sessions.classId, allowed))!);
  }

  return sessionQuery()
    .where(and(...conditions))
    .orderBy(asc(sessions.date), asc(sessions.startTime));
}

/**
 * Ngày của buổi học sắp tới gần nhất (chưa hủy) của lớp, tính từ `from`; không còn buổi nào thì lấy buổi gần nhất đã qua.
 * Dùng để mở Thời khóa biểu đúng tuần có buổi của lớp.
 */
export async function nextSessionDate(actor: Actor, classId: string, from: string): Promise<string | null> {
  assertCan(actor, "timetable", "view");
  await assertClassAccess(actor, classId);
  const base = and(eq(sessions.classId, classId), ne(sessions.status, "cancelled"));
  const [next] = await db.select({ date: sessions.date }).from(sessions).where(and(base, gte(sessions.date, from))).orderBy(asc(sessions.date)).limit(1);
  if (next) return next.date;
  const [last] = await db.select({ date: sessions.date }).from(sessions).where(base).orderBy(desc(sessions.date)).limit(1);
  return last?.date ?? null;
}

/**
 * Tình trạng lịch học của lớp cho trang Lớp học: số buổi đã xếp, buổi đầu/cuối,
 * số buổi đã dạy, buổi chưa có GV chính, và vài buổi sắp tới (kèm GV, trợ giảng, phòng).
 */
export async function classScheduleOverview(actor: Actor, classId: string, today: string = todayIso()) {
  assertCanAny(actor, ["classes", "view"], ["timetable", "view"]);
  await assertClassAccess(actor, classId);
  const all = await sessionQuery().where(eq(sessions.classId, classId)).orderBy(asc(sessions.date), asc(sessions.startTime));
  const active = all.filter((s) => s.status !== "cancelled");
  const regular = active.filter((s) => s.kind === "regular");
  return {
    scheduled: regular.length,
    done: active.filter((s) => s.status === "done").length,
    cancelled: all.length - active.length,
    makeup: active.length - regular.length,
    first: active[0] ?? null,
    last: active.at(-1) ?? null,
    missingTeacher: active.filter((s) => !s.teacherId && !s.substituteTeacherId).length,
    upcoming: active.filter((s) => s.date >= today && s.status === "planned").slice(0, 5),
  };
}

export async function getSession(actor: Actor, sessionId: string): Promise<SessionRow> {
  await assertSessionAccess(actor, sessionId);
  const [row] = await sessionQuery().where(eq(sessions.id, sessionId)).limit(1);
  if (!row) throw notFound("buổi học");
  return row;
}

// ---------- Lịch mẫu ----------

export async function listTemplates(actor: Actor, classId: string) {
  assertCanAny(actor, ["classes", "view"], ["timetable", "view"]);
  await assertClassAccess(actor, classId);
  return db
    .select({
      id: scheduleTemplates.id,
      weekday: scheduleTemplates.weekday,
      timeSlotId: scheduleTemplates.timeSlotId,
      slotName: timeSlots.name,
      slotStart: timeSlots.defaultStart,
      slotEnd: timeSlots.defaultEnd,
      startTime: scheduleTemplates.startTime,
      endTime: scheduleTemplates.endTime,
      roomId: scheduleTemplates.roomId,
      roomName: rooms.name,
      teacherId: scheduleTemplates.teacherId,
      teacherName: teachers.fullName,
      assistantTeacherId: scheduleTemplates.assistantTeacherId,
      assistantName: assistant.fullName,
    })
    .from(scheduleTemplates)
    .innerJoin(timeSlots, eq(timeSlots.id, scheduleTemplates.timeSlotId))
    .leftJoin(rooms, eq(rooms.id, scheduleTemplates.roomId))
    .leftJoin(teachers, eq(teachers.id, scheduleTemplates.teacherId))
    .leftJoin(assistant, eq(assistant.id, scheduleTemplates.assistantTeacherId))
    .where(eq(scheduleTemplates.classId, classId))
    .orderBy(asc(scheduleTemplates.weekday), asc(timeSlots.defaultStart));
}

// Thêm/sửa/xóa dòng lịch mẫu là một phần của "Sửa lớp".

/** Trợ giảng phải khác giáo viên chính của cùng dòng lịch mẫu / buổi học. */
function assertDistinctAssistant(teacherId: string | null | undefined, assistantTeacherId: string | null | undefined) {
  if (assistantTeacherId && assistantTeacherId === teacherId) {
    throw new AppError("VALIDATION", "Trợ giảng phải khác giáo viên chính.", { assistantTeacherId: "Phải khác GV chính" });
  }
}

type TemplateRow = typeof scheduleTemplates.$inferSelect;
type ClassRow = typeof classes.$inferSelect;

/** Giá trị một dòng lịch mẫu áp cho buổi học: giờ riêng hoặc giờ của ca, phòng mặc định, GV chính của lớp. */
async function templateApplier(tx: Tx, cls: ClassRow) {
  const [mainTeacher] = await tx
    .select({ teacherId: classTeachers.teacherId })
    .from(classTeachers)
    .where(and(eq(classTeachers.classId, cls.id), eq(classTeachers.role, "main")))
    .limit(1);
  const slotRows = await tx.select().from(timeSlots);
  const slotOf = new Map(slotRows.map((s) => [s.id, s]));
  return (t: TemplateRow) => {
    const slot = slotOf.get(t.timeSlotId);
    return {
      timeSlotId: t.timeSlotId,
      startTime: (t.startTime ?? slot?.defaultStart ?? "").slice(0, 5),
      endTime: (t.endTime ?? slot?.defaultEnd ?? "").slice(0, 5),
      roomId: t.roomId ?? cls.defaultRoomId,
      teacherId: t.teacherId ?? mainTeacher?.teacherId ?? null,
      assistantTeacherId: t.assistantTeacherId,
    };
  };
}

/** Buổi sắp tới còn "nguyên như lịch mẫu sinh ra": chưa diễn ra, chưa điểm danh/ghi sao, chưa dời, chưa sửa tay. */
async function untouchedFutureSessions(tx: Tx, cls: ClassRow, from: string, apply: (t: TemplateRow) => ReturnType<Awaited<ReturnType<typeof templateApplier>>>) {
  const templates = await tx.select().from(scheduleTemplates).where(eq(scheduleTemplates.classId, cls.id));
  const valuesOf = new Map(templates.map((t) => [t.id, apply(t)]));
  const rows = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.classId, cls.id),
        gte(sessions.date, from),
        eq(sessions.status, "planned"),
        eq(sessions.kind, "regular"),
        isNull(sessions.originalDate),
        isNull(sessions.substituteTeacherId),
        sql`not exists (select 1 from ${attendances} where ${attendances.sessionId} = ${sessions.id})`,
        sql`not exists (select 1 from ${starLogs} where ${starLogs.sessionId} = ${sessions.id})`,
      ),
    );
  return rows.filter((s) => {
    const v = s.templateId ? valuesOf.get(s.templateId) : undefined;
    return (
      v !== undefined &&
      !s.content &&
      !s.note &&
      s.startTime.slice(0, 5) === v.startTime &&
      s.endTime.slice(0, 5) === v.endTime &&
      s.roomId === v.roomId &&
      s.teacherId === v.teacherId &&
      s.assistantTeacherId === v.assistantTeacherId
    );
  });
}

/**
 * Xếp lại các buổi sắp tới của cả lớp theo toàn bộ lịch mẫu (sau khi thêm dòng lịch mẫu hoặc đổi thứ):
 * bỏ các buổi sắp tới còn nguyên như lịch mẫu sinh ra rồi sinh lại theo thứ tự ngày, đến ngày kết thúc của lớp.
 * Buổi đã dạy, đã điểm danh/ghi sao, đã dời hay sửa tay được giữ nguyên.
 */
async function reflowClass(tx: Tx, actor: Actor, cls: ClassRow, from: string): Promise<GenerationResult> {
  const apply = await templateApplier(tx, cls);
  const stale = await untouchedFutureSessions(tx, cls, from, apply);
  if (stale.length > 0) await tx.delete(sessions).where(inArray(sessions.id, stale.map((s) => s.id)));
  const result = await generateInTx(tx, actor, cls.id, undefined, from);
  // Buổi xóa rồi sinh lại đúng chỗ cũ không tính là "tạo mới".
  const recreated = Math.min(stale.length, result.created);
  return { ...result, created: result.created - recreated, alreadyExisting: result.alreadyExisting + recreated };
}

/** Thêm dòng lịch mẫu rồi tự xếp lại các buổi sắp tới của lớp đến ngày kết thúc của lớp (bỏ ngày nghỉ, báo buổi bị trùng). */
/** Một lớp không có hai dòng lịch mẫu cùng Thứ + Ca + Khung giờ. */
async function assertTemplateUnique(tx: Tx, classId: string, data: { weekday: number; timeSlotId: string }, exceptId?: string) {
  const conditions = [eq(scheduleTemplates.classId, classId), eq(scheduleTemplates.weekday, data.weekday), eq(scheduleTemplates.timeSlotId, data.timeSlotId)];
  if (exceptId) conditions.push(ne(scheduleTemplates.id, exceptId));
  const [dup] = await tx.select({ id: scheduleTemplates.id }).from(scheduleTemplates).where(and(...conditions)).limit(1);
  if (dup) {
    const message = `Lớp đã có lịch mẫu vào ${WEEKDAY_LABELS[data.weekday]}, ca và khung giờ này.`;
    throw new AppError("VALIDATION", message, { timeSlotId: message });
  }
}

export async function createTemplate(actor: Actor, data: z.output<typeof templateInput>, now: Date = new Date()): Promise<GenerationResult> {
  assertCan(actor, "classes", "edit");
  await assertClassAccess(actor, data.classId);
  assertDistinctAssistant(data.teacherId, data.assistantTeacherId);
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    const [cls] = await tx.select().from(classes).where(eq(classes.id, data.classId)).limit(1);
    if (!cls) throw notFound("lớp học");
    await assertTemplateUnique(tx, data.classId, data);
    const [row] = await tx.insert(scheduleTemplates).values(data).returning();
    await audit(tx, { userId: actor.userId, action: "create", tableName: "schedule_templates", recordId: row!.id, newValue: row });
    if (cls.status !== "open") return { created: 0, alreadyExisting: 0, conflicts: [], warnings: [] };
    return withNotices(await reflowClass(tx, actor, cls, todayIso(now)));
  });
}

/**
 * Sửa dòng lịch mẫu và áp sang các buổi TƯƠNG LAI chưa điểm danh của dòng đó.
 * Chỉ đổi những trường của buổi còn đúng giá trị cũ của lịch mẫu, nên buổi đã sửa tay riêng được giữ nguyên.
 * Đổi thứ trong tuần: xóa các buổi tương lai chưa điểm danh của dòng đó rồi sinh lại theo thứ mới.
 * Buổi bị trùng lịch sau khi đổi thì giữ nguyên và được báo lại.
 */
export async function updateTemplate(
  actor: Actor,
  input: z.output<typeof templateUpdateInput>,
  now: Date = new Date(),
): Promise<GenerationResult & { updated: number }> {
  assertCan(actor, "classes", "edit");
  const { id, ...data } = input;
  assertDistinctAssistant(data.teacherId, data.assistantTeacherId);
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    const [before] = await tx.select().from(scheduleTemplates).where(eq(scheduleTemplates.id, id)).for("update").limit(1);
    if (!before) throw notFound("lịch mẫu");
    await assertClassAccess(actor, before.classId, tx);
    const [cls] = await tx.select().from(classes).where(eq(classes.id, before.classId)).limit(1);
    if (!cls) throw notFound("lớp học");
    await assertTemplateUnique(tx, before.classId, data, id);
    const [after] = await tx.update(scheduleTemplates).set(data).where(eq(scheduleTemplates.id, id)).returning();
    await audit(tx, { userId: actor.userId, action: "update", tableName: "schedule_templates", recordId: id, oldValue: before, newValue: after });

    const result: GenerationResult & { updated: number } = { created: 0, alreadyExisting: 0, conflicts: [], warnings: [], updated: 0 };
    if (cls.status !== "open") return result;
    const today = todayIso(now);
    const upcoming = await tx
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.templateId, id),
          gte(sessions.date, today),
          eq(sessions.status, "planned"),
          sql`not exists (select 1 from ${attendances} where ${attendances.sessionId} = ${sessions.id})`,
        ),
      );

    const applied = await templateApplier(tx, cls);
    const oldValues = applied(before);
    const newValues = applied(after!);

    if (before.weekday !== after!.weekday) {
      // Đổi thứ: buổi sắp tới chưa điểm danh của dòng này được bỏ, rồi xếp lại cả lớp theo lịch mẫu mới đến ngày kết thúc của lớp.
      if (upcoming.length > 0) {
        await tx.delete(sessions).where(inArray(sessions.id, upcoming.map((u) => u.id)));
      }
      return withNotices({ ...result, ...(await reflowClass(tx, actor, cls, today)), updated: 0 });
    }

    const busy = await loadBusy(tx, today, cls.endDate);

    for (const s of upcoming) {
      const patch: Partial<typeof sessions.$inferInsert> = {};
      // Giờ chỉ đổi khi buổi còn đúng giờ cũ của lịch mẫu (chưa sửa tay); ca đi theo giờ.
      if (s.startTime.slice(0, 5) === oldValues.startTime && s.endTime.slice(0, 5) === oldValues.endTime) {
        if (oldValues.startTime !== newValues.startTime || oldValues.endTime !== newValues.endTime || s.timeSlotId !== newValues.timeSlotId) {
          Object.assign(patch, { startTime: newValues.startTime, endTime: newValues.endTime, timeSlotId: newValues.timeSlotId });
        }
      }
      for (const key of ["roomId", "teacherId", "assistantTeacherId"] as const) {
        if (s[key] === oldValues[key] && oldValues[key] !== newValues[key]) patch[key] = newValues[key];
      }
      if (Object.keys(patch).length === 0) continue;
      const next = { ...s, ...patch };
      if (next.assistantTeacherId && next.assistantTeacherId === (next.substituteTeacherId ?? next.teacherId)) {
        result.conflicts.push({ date: s.date, startTime: s.startTime.slice(0, 5), reason: "Trợ giảng trùng với giáo viên dạy buổi này" });
        continue;
      }
      const conflicts = findConflicts(
        {
          id: s.id,
          date: next.date,
          startTime: next.startTime,
          endTime: next.endTime,
          timeSlotId: next.timeSlotId ?? null,
          roomId: next.roomId ?? null,
          teacherIds: staffOf(next),
        },
        busy,
      );
      if (conflicts.length > 0) {
        result.conflicts.push({ date: s.date, startTime: s.startTime.slice(0, 5), reason: [...new Set(conflicts.map(describeConflict))].join("; ") });
        continue;
      }
      await tx.update(sessions).set({ ...patch, updatedAt: new Date() }).where(eq(sessions.id, s.id));
      const index = busy.findIndex((b) => b.id === s.id);
      const entry = {
        id: s.id,
        date: next.date,
        startTime: next.startTime,
        endTime: next.endTime,
        timeSlotId: next.timeSlotId ?? null,
        roomId: next.roomId ?? null,
        teacherIds: staffOf(next),
        label: cls.code,
      };
      if (index >= 0) busy[index] = entry;
      else busy.push(entry);
      result.updated++;
    }
    if (result.updated > 0) {
      await audit(tx, {
        userId: actor.userId,
        action: "sessions_updated_from_template",
        tableName: "sessions",
        recordId: id,
        newValue: { updated: result.updated, conflicts: result.conflicts.length },
      });
    }
    return withNotices(result);
  });
}

/** Xóa dòng lịch mẫu không xóa các buổi đã sinh (template_id của buổi thành null). */
export async function deleteTemplate(actor: Actor, id: string) {
  assertCan(actor, "classes", "edit");
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(scheduleTemplates).where(eq(scheduleTemplates.id, id)).limit(1);
    if (!before) throw notFound();
    await assertClassAccess(actor, before.classId, tx);
    await tx.delete(scheduleTemplates).where(eq(scheduleTemplates.id, id));
    await audit(tx, { userId: actor.userId, action: "delete", tableName: "schedule_templates", recordId: id, oldValue: before });
  });
}

// ---------- Kiểm tra trùng lịch ----------

/** Mọi thay đổi lịch chạy tuần tự để hai thao tác đồng thời không cùng lọt qua kiểm tra trùng. */
const lockSchedule = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock(727001)`);

async function loadBusy(tx: Tx, from: string, to: string): Promise<BusySession[]> {
  const rows = await tx
    .select({
      id: sessions.id,
      date: sessions.date,
      startTime: sessions.startTime,
      endTime: sessions.endTime,
      timeSlotId: sessions.timeSlotId,
      roomId: sessions.roomId,
      teacherId: sessions.teacherId,
      substituteTeacherId: sessions.substituteTeacherId,
      assistantTeacherId: sessions.assistantTeacherId,
      label: classes.code,
    })
    .from(sessions)
    .innerJoin(classes, eq(classes.id, sessions.classId))
    .where(and(between(sessions.date, from, to), ne(sessions.status, "cancelled")));
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    startTime: r.startTime,
    endTime: r.endTime,
    timeSlotId: r.timeSlotId,
    roomId: r.roomId,
    label: r.label,
    teacherIds: staffOf(r),
  }));
}

type Candidate = {
  id?: string;
  date: string;
  startTime: string;
  endTime: string;
  /** Ca + Khung giờ; null = buổi giờ tự do. */
  timeSlotId: string | null;
  roomId: string | null;
  /** Người đứng lớp: GV thực dạy (đã tính dạy thay) và trợ giảng. */
  teacherIds: string[];
};

/** Trùng GV hoặc phòng trong cùng Ca + Khung giờ (buổi giờ tự do: theo giờ thực tế) → CHẶN. */
function assertNoConflict(candidate: Candidate, busy: BusySession[]) {
  const conflicts = findConflicts(candidate, busy);
  if (conflicts.length > 0) {
    throw new AppError("CONFLICT", `Trùng lịch: ${[...new Set(conflicts.map(describeConflict))].join("; ")}.`);
  }
}

/** Vượt sức chứa phòng → chỉ CẢNH BÁO. */
async function capacityWarnings(tx: Tx, roomId: string | null, headcount: number): Promise<string[]> {
  if (!roomId) return [];
  const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).limit(1);
  return room && headcount > room.capacity
    ? [`Phòng ${room.name} chỉ chứa ${room.capacity} người nhưng buổi học có ${headcount} học viên.`]
    : [];
}

async function headcountOf(tx: Tx, session: { id: string; classId: string; date: string; kind: "regular" | "makeup" }) {
  if (session.kind === "makeup") {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(sessionStudents)
      .where(eq(sessionStudents.sessionId, session.id));
    return row?.n ?? 0;
  }
  const rows = await tx
    .select({ joinedAt: enrollments.joinedAt, leftAt: enrollments.leftAt })
    .from(enrollments)
    .where(eq(enrollments.classId, session.classId));
  return rows.filter((e) => isEnrolledOn(e, session.date)).length;
}

export type ScheduleResult = { warnings: string[] };

// ---------- Sinh buổi ----------

export type GenerationResult = {
  created: number;
  alreadyExisting: number;
  conflicts: { date: string; startTime: string; reason: string }[];
  warnings: string[];
  /** Số buổi lớp đang có (không tính buổi hủy, buổi bù). */
  scheduled?: number;
  /** Thông báo cho người dùng sau khi tự sinh/cập nhật buổi (hiện dạng toast thông tin). */
  notices?: string[];
};

/** Kèm thông báo dễ đọc cho kết quả tự sinh/tự cập nhật buổi: số buổi thêm/đổi và từng buổi bị trùng lịch. */
function withNotices<T extends GenerationResult & { updated?: number }>(result: T): T {
  const notices: string[] = [];
  if (result.created > 0) notices.push(`Đã tự thêm ${result.created} buổi vào Thời khóa biểu.`);
  if (result.updated) notices.push(`Đã cập nhật ${result.updated} buổi sắp tới theo lịch mẫu.`);
  const skipped = result.conflicts.map((c) => `Bỏ qua buổi ${formatDate(c.date)} ${c.startTime.slice(0, 5)}: ${c.reason}.`);
  return { ...result, notices, warnings: [...result.warnings, ...skipped] };
}

/**
 * Nút "Sinh buổi học từ lịch mẫu": xếp lại toàn bộ lịch của lớp theo lịch mẫu hiện tại.
 * Bỏ mọi buổi thường CHƯA DẠY (chưa điểm danh, chưa ghi sao, chưa hủy) — kể cả buổi xếp tay hay đã sửa riêng —
 * rồi sinh lại trong khoảng ngày của lớp, đúng thứ, ca, phòng và GV chính/trợ giảng của từng dòng lịch mẫu,
 * cho mọi tuần trong thời gian của lớp (lớp không gắn với khóa học nên không có số buổi cố định). Buổi đã dạy và buổi đã hủy được giữ.
 */
export async function rebuildSchedule(actor: Actor, classId: string): Promise<GenerationResult & { removed: number }> {
  assertCan(actor, "classes", "edit");
  await assertClassAccess(actor, classId);
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    const [cls] = await tx.select({ status: classes.status }).from(classes).where(eq(classes.id, classId)).limit(1);
    if (!cls) throw notFound("lớp học");
    if (cls.status !== "open") throw new AppError("CONFLICT", "Lớp đã đóng, không thể sinh buổi học.");
    const [template] = await tx.select({ id: scheduleTemplates.id }).from(scheduleTemplates).where(eq(scheduleTemplates.classId, classId)).limit(1);
    if (!template) throw new AppError("VALIDATION", "Lớp chưa có lịch mẫu.");
    const removed = await tx
      .delete(sessions)
      .where(
        and(
          eq(sessions.classId, classId),
          eq(sessions.kind, "regular"),
          eq(sessions.status, "planned"),
          sql`not exists (select 1 from ${attendances} where ${attendances.sessionId} = ${sessions.id})`,
          sql`not exists (select 1 from ${starLogs} where ${starLogs.sessionId} = ${sessions.id})`,
        ),
      )
      .returning({ id: sessions.id });
    const result = await generateInTx(tx, actor, classId);
    await audit(tx, {
      userId: actor.userId,
      action: "schedule_rebuilt",
      tableName: "sessions",
      recordId: classId,
      newValue: { removed: removed.length, created: result.created },
    });
    return { ...result, removed: removed.length };
  });
}

/**
 * Sinh bổ sung buổi học từ lịch mẫu trong khoảng ngày của lớp, bỏ ngày nghỉ (dùng cho dữ liệu mẫu).
 * Chạy lại nhiều lần an toàn: buổi đã có (kể cả đã dời/sửa giờ) không bị tạo lại hay ghi đè.
 * Buổi trùng GV/phòng không được tạo và được trả về trong `conflicts`.
 */
export async function generateSessions(actor: Actor, classId: string): Promise<GenerationResult> {
  assertCan(actor, "classes", "edit");
  await assertClassAccess(actor, classId);
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    return generateInTx(tx, actor, classId);
  });
}

/**
 * Lõi sinh buổi, chạy trong transaction đã khóa lịch. `templateId`: chỉ sinh cho một dòng lịch mẫu;
 * `fromDate`: chỉ sinh các buổi từ ngày này trở đi (dùng khi tự sinh sau khi thêm/sửa lịch mẫu).
 */
async function generateInTx(tx: Tx, actor: Actor, classId: string, templateId?: string, fromDate?: string): Promise<GenerationResult> {
  const [cls] = await tx.select().from(classes).where(eq(classes.id, classId)).limit(1);
  if (!cls) throw notFound("lớp học");
  if (cls.status !== "open") throw new AppError("CONFLICT", "Lớp đã đóng, không thể sinh buổi học.");

  const templates = await tx
    .select({
      id: scheduleTemplates.id,
      weekday: scheduleTemplates.weekday,
      timeSlotId: scheduleTemplates.timeSlotId,
      slotStart: timeSlots.defaultStart,
      slotEnd: timeSlots.defaultEnd,
      startTime: scheduleTemplates.startTime,
      endTime: scheduleTemplates.endTime,
      roomId: scheduleTemplates.roomId,
      teacherId: scheduleTemplates.teacherId,
      assistantTeacherId: scheduleTemplates.assistantTeacherId,
    })
    .from(scheduleTemplates)
    .innerJoin(timeSlots, eq(timeSlots.id, scheduleTemplates.timeSlotId))
    .where(and(eq(scheduleTemplates.classId, classId), templateId ? eq(scheduleTemplates.id, templateId) : undefined));
  if (templates.length === 0) throw new AppError("VALIDATION", "Lớp chưa có lịch mẫu.");

  // Lớp không gắn với một khóa học nên không có số buổi cố định: xếp buổi cho mọi tuần từ ngày bắt đầu đến ngày kết thúc của lớp.
  const horizon = cls.endDate;
  const holidayRows = await tx
    .select({ date: holidays.date })
    .from(holidays)
    .where(
      and(
        gte(holidays.date, cls.startDate),
        lte(holidays.date, horizon),
        or(isNull(holidays.classId), eq(holidays.classId, classId)),
      ),
    );
  const [mainTeacher] = await tx
    .select({ teacherId: classTeachers.teacherId })
    .from(classTeachers)
    .where(and(eq(classTeachers.classId, classId), eq(classTeachers.role, "main")))
    .limit(1);

  const planned = planSessions({
    startDate: fromDate && fromDate > cls.startDate ? fromDate : cls.startDate,
    // Buổi đầu vào đúng ngày khai giảng, trừ khi lớp đã bắt đầu và chỉ sinh tiếp từ hôm nay.
    firstOnStartDate: !fromDate || fromDate <= cls.startDate,
    endDate: horizon,
    templates,
    holidays: new Set(holidayRows.map((h) => h.date)),
    defaultRoomId: cls.defaultRoomId,
    defaultTeacherId: mainTeacher?.teacherId ?? null,
  });

  // Khóa nhận diện buổi đã sinh: dòng lịch mẫu + ngày GỐC (buổi đã dời vẫn được nhận ra).
  const existing = await tx
    .select({
      templateId: sessions.templateId,
      date: sessions.date,
      originalDate: sessions.originalDate,
      timeSlotId: sessions.timeSlotId,
      kind: sessions.kind,
      status: sessions.status,
    })
    .from(sessions)
    .where(eq(sessions.classId, classId));
  const existingKeys = new Set(existing.map((s) => `${s.templateId}|${s.originalDate ?? s.date}`));
  // Ngày + khung giờ mà CHÍNH lớp này đã có buổi: dòng lịch mẫu bị lặp (cùng thứ, cùng khung) không tạo buổi thứ hai
  // và cũng không bị báo là trùng lịch với chính lớp mình.
  const ownSlots = new Set(existing.filter((s) => s.status !== "cancelled" && s.timeSlotId).map((s) => `${s.date}|${s.timeSlotId}`));
  const counted = existing.filter((s) => s.kind === "regular" && s.status !== "cancelled").length;

  const busy = await loadBusy(tx, cls.startDate, horizon);
  const result: GenerationResult = { created: 0, alreadyExisting: 0, conflicts: [], warnings: [] };
  const toInsert: (typeof sessions.$inferInsert)[] = [];

  for (const p of planned) {
    if (existingKeys.has(`${p.templateId}|${p.date}`)) {
      result.alreadyExisting++;
      continue;
    }
    if (ownSlots.has(`${p.date}|${p.timeSlotId}`)) {
      result.alreadyExisting++;
      continue;
    }
    if (p.assistantTeacherId && p.assistantTeacherId === p.teacherId) {
      result.conflicts.push({ date: p.date, startTime: p.startTime, reason: "Trợ giảng trùng với giáo viên chính" });
      continue;
    }
    const conflicts = findConflicts({ ...p, teacherIds: staffOf(p) }, busy);
    if (conflicts.length > 0) {
      result.conflicts.push({ date: p.date, startTime: p.startTime, reason: [...new Set(conflicts.map(describeConflict))].join("; ") });
      continue;
    }
    toInsert.push({ ...p, classId, kind: "regular", status: "planned" });
    // Buổi vừa lên kế hoạch cũng chiếm GV/phòng đối với các buổi sau trong cùng lần sinh.
    busy.push({ id: `new-${toInsert.length}`, label: cls.code, ...p, teacherIds: staffOf(p) });
    ownSlots.add(`${p.date}|${p.timeSlotId}`);
  }

  result.scheduled = counted + toInsert.length;
  if (toInsert.length > 0) {
    await tx.insert(sessions).values(toInsert);
    result.created = toInsert.length;
    const roomIds = [...new Set(toInsert.map((s) => s.roomId).filter((r): r is string => Boolean(r)))];
    const headcount = await headcountOf(tx, { id: "", classId, date: cls.startDate, kind: "regular" });
    for (const roomId of roomIds) result.warnings.push(...(await capacityWarnings(tx, roomId, headcount)));
  }
  await audit(tx, {
    userId: actor.userId,
    action: "sessions_generated",
    tableName: "sessions",
    recordId: classId,
    newValue: { created: result.created, conflicts: result.conflicts.length, templateId: templateId ?? null },
  });
  return result;
}

// ---------- Điều chỉnh từng buổi ----------

/** Nạp buổi để sửa (khóa dòng) và bảo đảm lớp của buổi nằm trong phạm vi của người thao tác. */
async function loadForChange(tx: Tx, actor: Actor, sessionId: string) {
  const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for("update").limit(1);
  if (!row) throw notFound("buổi học");
  await assertClassAccess(actor, row.classId, tx);
  return row;
}

async function applyChange(
  tx: Tx,
  actor: Actor,
  before: typeof sessions.$inferSelect,
  patch: Partial<typeof sessions.$inferInsert>,
  action: string,
): Promise<ScheduleResult> {
  const next = { ...before, ...patch };
  let warnings: string[] = [];
  if (next.status !== "cancelled") {
    assertDistinctAssistant(next.substituteTeacherId ?? next.teacherId, next.assistantTeacherId);
    assertNoConflict(
      {
        id: before.id,
        date: next.date,
        startTime: next.startTime,
        endTime: next.endTime,
        timeSlotId: next.timeSlotId ?? null,
        roomId: next.roomId ?? null,
        teacherIds: staffOf(next),
      },
      await loadBusy(tx, next.date, next.date),
    );
    warnings = await capacityWarnings(tx, next.roomId ?? null, await headcountOf(tx, next));
  }
  const [after] = await tx
    .update(sessions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(sessions.id, before.id))
    .returning();
  await audit(tx, { userId: actor.userId, action, tableName: "sessions", recordId: before.id, oldValue: before, newValue: after });
  return { warnings };
}

/** Sửa giờ/phòng/GV/nội dung của RIÊNG một buổi; ca gốc và các buổi khác không đổi. */
export async function updateSession(actor: Actor, input: z.output<typeof sessionEditInput>): Promise<ScheduleResult> {
  assertCan(actor, "timetable", "edit");
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    const { id, ...patch } = input;
    const before = await loadForChange(tx, actor, id);
    if (before.status === "cancelled") throw new AppError("CONFLICT", "Buổi đã hủy. Hãy khôi phục trước khi sửa.");
    return applyChange(tx, actor, before, patch, "session_updated");
  });
}

/** Dời buổi sang ngày/giờ khác; lưu ngày gốc lần đầu dời. */
export async function rescheduleSession(actor: Actor, input: z.output<typeof sessionRescheduleInput>): Promise<ScheduleResult> {
  assertCan(actor, "timetable", "edit");
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    const before = await loadForChange(tx, actor, input.id);
    if (before.status !== "planned") throw new AppError("CONFLICT", "Chỉ dời được buổi chưa diễn ra và chưa hủy.");
    const result = await applyChange(
      tx,
      actor,
      before,
      {
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
        originalDate: before.originalDate ?? (input.date !== before.date ? before.date : null),
      },
      "session_rescheduled",
    );
    const [holiday] = await tx
      .select({ reason: holidays.reason })
      .from(holidays)
      .where(and(eq(holidays.date, input.date), or(isNull(holidays.classId), eq(holidays.classId, before.classId))))
      .limit(1);
    if (holiday) result.warnings.push(`Ngày mới trùng ngày nghỉ: ${holiday.reason}.`);
    return result;
  });
}

/** Hủy buổi: không cần điểm danh và không tính vào chuyên cần. */
export async function cancelSession(actor: Actor, input: z.output<typeof sessionCancelInput>): Promise<ScheduleResult> {
  assertCan(actor, "timetable", "edit");
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    const before = await loadForChange(tx, actor, input.id);
    if (before.status === "cancelled") throw new AppError("CONFLICT", "Buổi này đã hủy.");
    if (before.status === "done") throw new AppError("CONFLICT", "Buổi đã điểm danh nên không thể hủy.");
    return applyChange(tx, actor, before, { status: "cancelled", note: input.note ?? before.note }, "session_cancelled");
  });
}

export async function restoreSession(actor: Actor, sessionId: string): Promise<ScheduleResult> {
  assertCan(actor, "timetable", "edit");
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    const before = await loadForChange(tx, actor, sessionId);
    if (before.status !== "cancelled") throw new AppError("CONFLICT", "Buổi này không ở trạng thái đã hủy.");
    return applyChange(tx, actor, before, { status: "planned" }, "session_restored");
  });
}

/**
 * Admin xóa hẳn một buổi (xếp sai, dữ liệu thử), kể cả buổi đã điểm danh/ghi sao: điểm danh và sao của buổi
 * bị xóa theo. Lớp đã đóng (đã chốt tổng kết) thì không xóa được.
 */
export async function deleteSession(actor: Actor, sessionId: string): Promise<{ date: string; deletedAttendances: number; deletedStarLogs: number }> {
  assertAdmin(actor);
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    const before = await loadForChange(tx, actor, sessionId);
    const [cls] = await tx.select({ status: classes.status }).from(classes).where(eq(classes.id, before.classId)).limit(1);
    if (cls?.status !== "open") throw new AppError("CONFLICT", "Lớp đã đóng và đã chốt tổng kết nên không xóa buổi học được.");
    const deletedStarLogs = await purgeSessionStarLogs(tx, actor, sessionId);
    const removed = await tx.delete(attendances).where(eq(attendances.sessionId, sessionId)).returning({ id: attendances.id });
    await tx.delete(sessions).where(eq(sessions.id, sessionId));
    await audit(tx, {
      userId: actor.userId,
      action: "session_deleted",
      tableName: "sessions",
      recordId: sessionId,
      oldValue: before,
      newValue: { deletedAttendances: removed.length, deletedStarLogs },
    });
    return { date: before.date, deletedAttendances: removed.length, deletedStarLogs };
  });
}

/** Phân GV dạy thay: giữ GV gốc, lưu thêm GV thay. Để trống = bỏ dạy thay. */
export async function setSubstitute(actor: Actor, input: z.output<typeof sessionSubstituteInput>): Promise<ScheduleResult> {
  assertCan(actor, "timetable", "edit");
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    const before = await loadForChange(tx, actor, input.id);
    if (before.status === "cancelled") throw new AppError("CONFLICT", "Buổi đã hủy.");
    if (input.substituteTeacherId && input.substituteTeacherId === before.assistantTeacherId) {
      throw new AppError("VALIDATION", "GV dạy thay đang là trợ giảng của buổi này.", { substituteTeacherId: "Đang là trợ giảng" });
    }
    if (input.substituteTeacherId && input.substituteTeacherId === before.teacherId) {
      throw new AppError("VALIDATION", "GV dạy thay phải khác GV của buổi.", { substituteTeacherId: "Phải khác GV của buổi" });
    }
    return applyChange(tx, actor, before, { substituteTeacherId: input.substituteTeacherId }, "session_substitute_set");
  });
}

/** Thêm buổi bù chỉ gồm các học viên được chọn (phải đang ghi danh lớp tại ngày bù). */
export async function createMakeupSession(
  actor: Actor,
  input: z.output<typeof makeupInput>,
): Promise<ScheduleResult & { id: string }> {
  assertCan(actor, "timetable", "add");
  await assertClassAccess(actor, input.classId);
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    const [cls] = await tx.select().from(classes).where(eq(classes.id, input.classId)).limit(1);
    if (!cls) throw notFound("lớp học");
    if (cls.status !== "open") throw new AppError("CONFLICT", "Lớp đã đóng, không thể thêm buổi bù.");

    const studentIds = [...new Set(input.studentIds)];
    const enrolled = await tx
      .select({ studentId: enrollments.studentId, joinedAt: enrollments.joinedAt, leftAt: enrollments.leftAt })
      .from(enrollments)
      .where(and(eq(enrollments.classId, input.classId), inArray(enrollments.studentId, studentIds)));
    const valid = new Set(enrolled.filter((e) => isEnrolledOn(e, input.date)).map((e) => e.studentId));
    if (studentIds.some((id) => !valid.has(id))) {
      throw new AppError("VALIDATION", "Có học viên không thuộc lớp này tại ngày học bù.", { studentIds: "Học viên không thuộc lớp" });
    }

    assertNoConflict(
      // Buổi bù giờ tự do không gắn ca nên so trùng theo giờ thực tế.
      { date: input.date, startTime: input.startTime, endTime: input.endTime, timeSlotId: null, roomId: input.roomId, teacherIds: [input.teacherId] },
      await loadBusy(tx, input.date, input.date),
    );
    const [created] = await tx
      .insert(sessions)
      .values({
        classId: input.classId,
        date: input.date,
        startTime: input.startTime,
        endTime: input.endTime,
        roomId: input.roomId,
        teacherId: input.teacherId,
        kind: "makeup",
        status: "planned",
        note: input.note,
      })
      .returning();
    await tx.insert(sessionStudents).values(studentIds.map((studentId) => ({ sessionId: created!.id, studentId })));
    await audit(tx, {
      userId: actor.userId,
      action: "session_makeup_created",
      tableName: "sessions",
      recordId: created!.id,
      newValue: { ...created, studentIds },
    });
    return { id: created!.id, warnings: await capacityWarnings(tx, input.roomId, studentIds.length) };
  });
}

/**
 * Admin xếp tay một buổi học vào một ngày và ca bất kỳ (không qua lịch mẫu).
 * Giờ lấy từ ca; không chọn GV/phòng thì dùng GV chính và phòng mặc định của lớp.
 * Vẫn kiểm tra trùng GV/phòng theo giờ thực tế như mọi buổi khác.
 */
export async function createManualSession(
  actor: Actor,
  input: z.output<typeof manualSessionInput>,
): Promise<ScheduleResult & { id: string }> {
  assertCan(actor, "timetable", "add");
  await assertClassAccess(actor, input.classId);
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    const [cls] = await tx.select().from(classes).where(eq(classes.id, input.classId)).limit(1);
    if (!cls) throw notFound("lớp học");
    if (cls.status !== "open") throw new AppError("CONFLICT", "Lớp đã đóng, không thể xếp thêm buổi.");
    const [slot] = await tx.select().from(timeSlots).where(eq(timeSlots.id, input.timeSlotId)).limit(1);
    if (!slot) throw notFound("ca học");

    let teacherId = input.teacherId;
    if (!teacherId) {
      const [main] = await tx
        .select({ teacherId: classTeachers.teacherId })
        .from(classTeachers)
        .where(and(eq(classTeachers.classId, cls.id), eq(classTeachers.role, "main")))
        .limit(1);
      teacherId = main?.teacherId ?? null;
    }
    if (!teacherId) {
      throw new AppError("VALIDATION", "Lớp chưa có giáo viên chính. Hãy chọn giáo viên cho buổi này.", { teacherId: "Bắt buộc chọn" });
    }
    const candidate = {
      date: input.date,
      startTime: slot.defaultStart.slice(0, 5),
      endTime: slot.defaultEnd.slice(0, 5),
      roomId: input.roomId ?? cls.defaultRoomId,
      teacherId,
    };
    assertNoConflict({ ...candidate, timeSlotId: slot.id, teacherIds: [teacherId] }, await loadBusy(tx, input.date, input.date));

    const [created] = await tx
      .insert(sessions)
      .values({ ...candidate, classId: cls.id, timeSlotId: slot.id, kind: "regular", status: "planned" })
      .returning();
    await audit(tx, { userId: actor.userId, action: "session_created", tableName: "sessions", recordId: created!.id, newValue: created });

    const warnings = await capacityWarnings(tx, candidate.roomId, await headcountOf(tx, created!));
    if (input.date < cls.startDate || input.date > cls.endDate) warnings.push("Ngày này nằm ngoài thời gian học của lớp.");
    const [holiday] = await tx
      .select({ reason: holidays.reason })
      .from(holidays)
      .where(and(eq(holidays.date, input.date), or(isNull(holidays.classId), eq(holidays.classId, cls.id))))
      .limit(1);
    if (holiday) warnings.push(`Ngày này là ngày nghỉ: ${holiday.reason}.`);
    return { id: created!.id, warnings };
  });
}