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
  makeupAssignments,
  rooms,
  scheduleTemplates,
  sessionStudents,
  sessions,
  starLogs,
  teachers,
  timeSlots,
  timesheetOverrides,
} from "@/db/schema";
import {
  type BusySession,
  describeConflict,
  findConflicts,
  isEnrolledOn,
  planSessions,
  staffOf,
} from "@/domain/schedule";
import { WEEKDAY_LABELS, nextWeekRange } from "@/lib/dates";
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
 * số buổi đã dạy, buổi chưa có GV chính, vài buổi sắp tới (kèm GV, trợ giảng, phòng), và số buổi đã có của tuần sau.
 */
export async function classScheduleOverview(actor: Actor, classId: string, today: string = todayIso()) {
  assertCanAny(actor, ["classes", "view"], ["timetable", "view"]);
  await assertClassAccess(actor, classId);
  const all = await sessionQuery().where(eq(sessions.classId, classId)).orderBy(asc(sessions.date), asc(sessions.startTime));
  const active = all.filter((s) => s.status !== "cancelled");
  const regular = active.filter((s) => s.kind === "regular");
  const week = nextWeekRange(today);
  return {
    /** Tuần sẽ được sinh buổi khi bấm nút, và số buổi (chưa hủy) lớp đã có trong tuần đó. */
    nextWeek: { ...week, count: active.filter((s) => s.date >= week.from && s.date <= week.to).length },
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

// Buổi học được sinh theo từng tuần (mỗi tuần thứ, ca của lớp có thể đổi): lịch mẫu chỉ có hiệu lực khi bấm sinh lịch tuần sau.
// Thêm, sửa, xóa dòng lịch mẫu không tự tạo và không tự đổi buổi nào đã có trên Thời khóa biểu.

export async function createTemplate(actor: Actor, data: z.output<typeof templateInput>) {
  assertCan(actor, "classes", "edit");
  await assertClassAccess(actor, data.classId);
  assertDistinctAssistant(data.teacherId, data.assistantTeacherId);
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    const [cls] = await tx.select({ id: classes.id }).from(classes).where(eq(classes.id, data.classId)).limit(1);
    if (!cls) throw notFound("lớp học");
    await assertTemplateUnique(tx, data.classId, data);
    const [row] = await tx.insert(scheduleTemplates).values(data).returning();
    await audit(tx, { userId: actor.userId, action: "create", tableName: "schedule_templates", recordId: row!.id, newValue: row });
    return row!;
  });
}

export async function updateTemplate(actor: Actor, input: z.output<typeof templateUpdateInput>) {
  assertCan(actor, "classes", "edit");
  const { id, ...data } = input;
  assertDistinctAssistant(data.teacherId, data.assistantTeacherId);
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    const [before] = await tx.select().from(scheduleTemplates).where(eq(scheduleTemplates.id, id)).for("update").limit(1);
    if (!before) throw notFound("lịch mẫu");
    await assertClassAccess(actor, before.classId, tx);
    await assertTemplateUnique(tx, before.classId, data, id);
    const [after] = await tx.update(scheduleTemplates).set(data).where(eq(scheduleTemplates.id, id)).returning();
    await audit(tx, { userId: actor.userId, action: "update", tableName: "schedule_templates", recordId: id, oldValue: before, newValue: after });
    return after!;
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

type DateRange = { from: string; to: string };

export type GenerationResult = {
  created: number;
  alreadyExisting: number;
  conflicts: { date: string; startTime: string; reason: string }[];
  warnings: string[];
  /** Số buổi lớp đang có (không tính buổi hủy, buổi bù). */
  scheduled?: number;
};

/** Kết quả sinh lịch tuần sau: tuần đã sinh, số buổi tạo mới, số buổi chưa dạy bị thay, và các điều cần báo lại. */
export type WeekGeneration = { week: DateRange; created: number; removed: number; alreadyExisting: number; warnings: string[] };

/** Lời báo cho một buổi không tạo được vì trùng lịch; `code`: mã lớp khi sinh cho nhiều lớp cùng lúc. */
const skipNotice = (c: GenerationResult["conflicts"][number], code?: string) =>
  `${code ? `${code}: ` : ""}Bỏ qua buổi ${formatDate(c.date)} ${c.startTime.slice(0, 5)}: ${c.reason}.`;

/** Buổi chưa được dùng ở đâu: chưa điểm danh, chưa ghi sao, chưa có em nào được xếp học bù vào, chưa chỉnh chấm công. */
const unusedSession = () =>
  and(
    sql`not exists (select 1 from ${attendances} where ${attendances.sessionId} = ${sessions.id})`,
    sql`not exists (select 1 from ${starLogs} where ${starLogs.sessionId} = ${sessions.id})`,
    sql`not exists (select 1 from ${makeupAssignments} where ${makeupAssignments.makeupSessionId} = ${sessions.id} or ${makeupAssignments.absentSessionId} = ${sessions.id})`,
    sql`not exists (select 1 from ${timesheetOverrides} where ${timesheetOverrides.sessionId} = ${sessions.id})`,
  );

/**
 * Nút "Sinh buổi học tuần sau" ở trang chi tiết lớp: xếp lại tuần sau của lớp theo lịch mẫu hiện tại.
 * Bỏ các buổi thường CHƯA DẠY của tuần sau (chưa điểm danh, chưa ghi sao, chưa có em được xếp học bù vào) — kể cả buổi xếp tay
 * hay đã sửa riêng — rồi sinh lại đúng thứ, ca, phòng và GV chính/trợ giảng của từng dòng lịch mẫu.
 * Buổi đã dạy, buổi đã hủy, buổi bù và mọi buổi của các tuần khác được giữ nguyên.
 */
export async function generateNextWeek(actor: Actor, classId: string, now: Date = new Date()): Promise<WeekGeneration> {
  assertCan(actor, "classes", "edit");
  await assertClassAccess(actor, classId);
  const week = nextWeekRange(todayIso(now));
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    const [cls] = await tx.select().from(classes).where(eq(classes.id, classId)).limit(1);
    if (!cls) throw notFound("lớp học");
    if (cls.status !== "open") throw new AppError("CONFLICT", "Lớp đã đóng, không thể sinh buổi học.");
    const [template] = await tx.select({ id: scheduleTemplates.id }).from(scheduleTemplates).where(eq(scheduleTemplates.classId, classId)).limit(1);
    if (!template) throw new AppError("VALIDATION", "Lớp chưa có lịch mẫu.");
    if (cls.startDate > week.to || cls.endDate < week.from) {
      throw new AppError(
        "VALIDATION",
        `Tuần sau (${formatDate(week.from)} – ${formatDate(week.to)}) nằm ngoài thời gian học của lớp (${formatDate(cls.startDate)} – ${formatDate(cls.endDate)}). Hãy sửa ngày bắt đầu, ngày kết thúc của lớp nếu lớp có học tuần đó.`,
      );
    }
    const removed = await tx
      .delete(sessions)
      .where(
        and(
          eq(sessions.classId, classId),
          between(sessions.date, week.from, week.to),
          eq(sessions.kind, "regular"),
          eq(sessions.status, "planned"),
          unusedSession(),
        ),
      )
      .returning({ id: sessions.id });
    const result = await generateInTx(tx, actor, classId, week);
    await audit(tx, {
      userId: actor.userId,
      action: "schedule_rebuilt",
      tableName: "sessions",
      recordId: classId,
      newValue: { week, removed: removed.length, created: result.created },
    });
    return {
      week,
      created: result.created,
      removed: removed.length,
      alreadyExisting: result.alreadyExisting,
      warnings: [...result.warnings, ...result.conflicts.map((c) => skipNotice(c))],
    };
  });
}

/**
 * Nút "Sinh lịch tuần sau" ở Thời khóa biểu: bổ sung buổi còn thiếu của tuần sau cho mọi lớp đang mở có lịch mẫu
 * trong phạm vi của người bấm. Buổi đã có (kể cả đã dời, sửa tay, hủy) giữ nguyên; bấm lại không tạo trùng.
 * Lớp mà tuần sau nằm ngoài thời gian học thì không sinh và được báo lại.
 */
export async function generateNextWeekForAll(actor: Actor, now: Date = new Date()): Promise<WeekGeneration & { classCount: number }> {
  assertCan(actor, "timetable", "add");
  const week = nextWeekRange(todayIso(now));
  const allowed = await allowedClassIds(actor);
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    const result: WeekGeneration & { classCount: number } = { week, created: 0, removed: 0, alreadyExisting: 0, warnings: [], classCount: 0 };
    if (allowed !== null && allowed.length === 0) return result;
    const targets = await tx
      .selectDistinct({ id: classes.id, code: classes.code, startDate: classes.startDate, endDate: classes.endDate })
      .from(classes)
      .innerJoin(scheduleTemplates, eq(scheduleTemplates.classId, classes.id))
      .where(and(eq(classes.status, "open"), allowed === null ? undefined : inArray(classes.id, allowed)))
      .orderBy(asc(classes.code));
    const outside: string[] = [];
    for (const cls of targets) {
      if (cls.startDate > week.to || cls.endDate < week.from) {
        outside.push(cls.code);
        continue;
      }
      const one = await generateInTx(tx, actor, cls.id, week);
      result.classCount++;
      result.created += one.created;
      result.alreadyExisting += one.alreadyExisting;
      result.warnings.push(...one.warnings.map((w) => `${cls.code}: ${w}`), ...one.conflicts.map((c) => skipNotice(c, cls.code)));
    }
    if (outside.length > 0) {
      result.warnings.push(`Không sinh buổi cho ${outside.join(", ")}: tuần sau nằm ngoài thời gian học của lớp.`);
    }
    return result;
  });
}

/**
 * Sinh bổ sung buổi học từ lịch mẫu trong khoảng ngày của lớp (hoặc phần giao với `range`), bỏ ngày nghỉ.
 * Chỉ dùng cho dữ liệu mẫu và test; trên giao diện buổi học được sinh theo từng tuần (`generateNextWeek`, `generateNextWeekForAll`).
 * Chạy lại nhiều lần an toàn: buổi đã có (kể cả đã dời/sửa giờ) không bị tạo lại hay ghi đè.
 * Buổi trùng GV/phòng không được tạo và được trả về trong `conflicts`.
 */
export async function generateSessions(actor: Actor, classId: string, range?: DateRange): Promise<GenerationResult> {
  assertCan(actor, "classes", "edit");
  await assertClassAccess(actor, classId);
  return db.transaction(async (tx) => {
    await lockSchedule(tx);
    return generateInTx(tx, actor, classId, range);
  });
}

/**
 * Lõi sinh buổi, chạy trong transaction đã khóa lịch: thêm các buổi còn thiếu theo lịch mẫu trong thời gian học của lớp,
 * giới hạn trong `range` nếu có (vd. tuần sau). Buổi đã có không bị đụng tới.
 */
async function generateInTx(tx: Tx, actor: Actor, classId: string, range?: DateRange): Promise<GenerationResult> {
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
    .where(eq(scheduleTemplates.classId, classId));
  if (templates.length === 0) throw new AppError("VALIDATION", "Lớp chưa có lịch mẫu.");

  const result: GenerationResult = { created: 0, alreadyExisting: 0, conflicts: [], warnings: [] };
  // Lớp không gắn với một khóa học nên không có số buổi cố định: chỉ xếp trong thời gian học của lớp.
  const from = range && range.from > cls.startDate ? range.from : cls.startDate;
  const to = range && range.to < cls.endDate ? range.to : cls.endDate;
  if (from > to) return result;

  const holidayRows = await tx
    .select({ date: holidays.date })
    .from(holidays)
    .where(and(gte(holidays.date, from), lte(holidays.date, to), or(isNull(holidays.classId), eq(holidays.classId, classId))));
  const [mainTeacher] = await tx
    .select({ teacherId: classTeachers.teacherId })
    .from(classTeachers)
    .where(and(eq(classTeachers.classId, classId), eq(classTeachers.role, "main")))
    .limit(1);

  const planned = planSessions({
    startDate: from,
    // Buổi đầu vào đúng ngày khai giảng khi khoảng sinh có ngày bắt đầu của lớp.
    firstOnStartDate: from === cls.startDate,
    endDate: to,
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

  const busy = await loadBusy(tx, from, to);
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
    const headcount = await headcountOf(tx, { id: "", classId, date: from, kind: "regular" });
    for (const roomId of roomIds) result.warnings.push(...(await capacityWarnings(tx, roomId, headcount)));
  }
  await audit(tx, {
    userId: actor.userId,
    action: "sessions_generated",
    tableName: "sessions",
    recordId: classId,
    newValue: { created: result.created, conflicts: result.conflicts.length, from, to },
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