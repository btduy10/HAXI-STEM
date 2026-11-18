import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { db, type DbOrTx } from "@/db";
import { attendances, classes, enrollments, makeupAssignments, sessionStudents, sessions, students } from "@/db/schema";
import { isAttendanceLocked, isEnrolledOn } from "@/domain/schedule";
import { todayIso } from "@/lib/format";
import type { attendanceInput } from "@/lib/validation/schedule";
import { audit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, assertAdmin, assertCan, assertSessionAccess, can, isTimetableOnly, seesAllClasses } from "../guard";
import { getSettings } from "../settings";
import { openSessionForWrite, sessionWriteState } from "./session-write";
import { lessonsForClass } from "./syllabus";

const UNLOCK_HOURS = 24;

type SessionCore = Pick<typeof sessions.$inferSelect, "id" | "classId" | "date" | "kind">;

export type RosterRow = { studentId: string; code: string; fullName: string; /** Học viên lớp khác được xếp học bù vào buổi này. */ makeup: boolean };

/**
 * Danh sách điểm danh của buổi: học viên có ghi danh hiệu lực TẠI NGÀY HỌC (buổi bù riêng chỉ gồm học viên được chọn),
 * cộng các em được xếp học bù vào buổi này (xếp sau cùng, đánh dấu `makeup`).
 */
export async function sessionRoster(tx: DbOrTx, session: SessionCore): Promise<RosterRow[]> {
  const [own, guests] = await Promise.all([
    ownRoster(tx, session),
    tx
      .select({ studentId: students.id, code: students.code, fullName: students.fullName })
      .from(makeupAssignments)
      .innerJoin(students, eq(students.id, makeupAssignments.studentId))
      .where(eq(makeupAssignments.makeupSessionId, session.id))
      .orderBy(asc(students.fullName)),
  ]);
  const ids = new Set(own.map((r) => r.studentId));
  return [...own.map((r) => ({ ...r, makeup: false })), ...guests.filter((g) => !ids.has(g.studentId)).map((g) => ({ ...g, makeup: true }))];
}

async function ownRoster(tx: DbOrTx, session: SessionCore) {
  if (session.kind === "makeup") {
    return tx
      .select({ studentId: students.id, code: students.code, fullName: students.fullName })
      .from(sessionStudents)
      .innerJoin(students, eq(students.id, sessionStudents.studentId))
      .where(eq(sessionStudents.sessionId, session.id))
      .orderBy(asc(students.fullName));
  }
  const rows = await tx
    .select({
      studentId: students.id,
      code: students.code,
      fullName: students.fullName,
      joinedAt: enrollments.joinedAt,
      leftAt: enrollments.leftAt,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .where(eq(enrollments.classId, session.classId))
    .orderBy(asc(students.fullName));
  const seen = new Set<string>();
  return rows
    .filter((r) => isEnrolledOn(r, session.date) && !seen.has(r.studentId) && seen.add(r.studentId))
    .map(({ studentId, code, fullName }) => ({ studentId, code, fullName }));
}

export async function getAttendanceSheet(actor: Actor, sessionId: string, now: Date = new Date()) {
  assertCan(actor, "attendance", "view");
  await assertSessionAccess(actor, sessionId);
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  // Buổi của lớp chỉ hiển thị trên Thời khóa biểu không có bảng điểm danh.
  if (!session || (await isTimetableOnly(session.classId))) throw notFound("buổi học");
  const [roster, existing, block, lessons] = await Promise.all([
    sessionRoster(db, session),
    db.select().from(attendances).where(eq(attendances.sessionId, sessionId)),
    sessionWriteState(session, "attendance", now),
    // Bài học trong Syllabus của lớp của buổi: người vào được buổi thì đọc được, không cần quyền menu Syllabus.
    lessonsForClass(session.classId),
  ]);
  const byStudent = new Map(existing.map((a) => [a.studentId, a]));
  const recorded = existing.length > 0;
  // Buổi chưa điểm danh cần quyền Thêm; buổi đã điểm danh cần quyền Sửa.
  const canSave = can(actor, "attendance", recorded ? "edit" : "add");
  return {
    recorded,
    lessons,
    teacherRemark: session.teacherRemark ?? "",
    canSave,
    /** Lý do của buổi học (đã hủy, chưa đến ngày, lớp đã đóng, quá hạn khóa…), không gồm quyền của người xem. */
    blockedReason: block?.message ?? null,
    /** Lý do bảng chỉ để xem: lý do của buổi học, hoặc người xem không có quyền lưu. null khi lưu được. */
    readOnlyReason:
      block?.message ??
      (canSave ? null : recorded ? "Bạn chỉ có quyền xem điểm danh đã lưu, không có quyền sửa." : "Bạn không có quyền điểm danh buổi chưa điểm danh."),
    /** Quá hạn khóa điểm danh: Admin mở khóa được. */
    locked: block?.code === "locked",
    // Mặc định "Có mặt" cho cả lớp; GV chỉ sửa những em khác.
    rows: roster.map((r) => ({
      ...r,
      status: byStudent.get(r.studentId)?.status ?? ("present" as const),
      note: byStudent.get(r.studentId)?.note ?? "",
    })),
  };
}

/** Lưu điểm danh cả buổi một lần. Mọi thay đổi so với lần trước được ghi vào audit_logs. */
export async function saveAttendance(actor: Actor, input: z.output<typeof attendanceInput>, now: Date = new Date()) {
  return db.transaction(async (tx) => {
    const session = await openSessionForWrite(actor, tx, input.sessionId, "attendance", now);

    const roster = await sessionRoster(tx, session);
    const rosterIds = new Set(roster.map((r) => r.studentId));
    const submitted = new Map(input.entries.map((e) => [e.studentId, e]));
    if (submitted.size !== rosterIds.size || [...submitted.keys()].some((id) => !rosterIds.has(id))) {
      throw new AppError("CONFLICT", "Danh sách học viên của buổi đã thay đổi. Vui lòng tải lại trang.");
    }

    const existing = await tx.select().from(attendances).where(eq(attendances.sessionId, session.id));
    assertCan(actor, "attendance", existing.length > 0 ? "edit" : "add");
    const before = new Map(existing.map((a) => [a.studentId, a]));
    let changed = 0;
    for (const entry of submitted.values()) {
      const old = before.get(entry.studentId);
      if (old && old.status === entry.status && (old.note ?? null) === entry.note) continue;
      changed++;
      await tx
        .insert(attendances)
        .values({ sessionId: session.id, studentId: entry.studentId, status: entry.status, note: entry.note, recordedBy: actor.userId, recordedAt: now })
        .onConflictDoUpdate({
          target: [attendances.sessionId, attendances.studentId],
          set: { status: entry.status, note: entry.note, recordedBy: actor.userId, recordedAt: now },
        });
      if (old) {
        await audit(tx, {
          userId: actor.userId,
          action: "attendance_updated",
          tableName: "attendances",
          recordId: old.id,
          oldValue: { status: old.status, note: old.note },
          newValue: { status: entry.status, note: entry.note, sessionId: session.id, studentId: entry.studentId },
        });
      }
    }
    if (existing.length === 0) {
      await audit(tx, {
        userId: actor.userId,
        action: "attendance_recorded",
        tableName: "sessions",
        recordId: session.id,
        newValue: { count: submitted.size },
      });
    }
    await tx
      .update(sessions)
      .set({
        status: "done",
        content: input.content ?? session.content,
        teacherRemark: input.remark === undefined ? session.teacherRemark : input.remark,
        updatedAt: now,
      })
      .where(eq(sessions.id, session.id));
    return { changed };
  });
}

/** Chỉ Admin: mở khóa sửa điểm danh của một buổi trong 24 giờ. */
export async function unlockAttendance(actor: Actor, sessionId: string, now: Date = new Date()) {
  assertAdmin(actor);
  const until = new Date(now.getTime() + UNLOCK_HOURS * 3_600_000);
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(sessions)
      .set({ attendanceUnlockedUntil: until, attendanceUnlockedBy: actor.userId })
      .where(eq(sessions.id, sessionId))
      .returning({ id: sessions.id });
    if (rows.length === 0) throw notFound("buổi học");
    await audit(tx, {
      userId: actor.userId,
      action: "attendance_unlocked",
      tableName: "sessions",
      recordId: sessionId,
      newValue: { until: until.toISOString() },
    });
    return rows[0]!;
  });
  return { id: updated.id, until };
}

/**
 * Buổi đã qua ngày mà chưa điểm danh. GV: các buổi mình thực dạy (đã tính dạy thay) hoặc trợ giảng.
 * Admin và phạm vi "Tất cả lớp": toàn trung tâm.
 */
export async function listOverdueSessions(actor: Actor, now: Date = new Date()) {
  const conditions = [lt(sessions.date, todayIso(now)), eq(sessions.status, "planned"), eq(classes.timetableOnly, false)];
  if (!seesAllClasses(actor)) {
    if (!actor.teacherId) return [];
    conditions.push(
      or(
        eq(sessions.substituteTeacherId, actor.teacherId),
        and(isNull(sessions.substituteTeacherId), eq(sessions.teacherId, actor.teacherId)),
        eq(sessions.assistantTeacherId, actor.teacherId),
      )!,
    );
  }
  const [rows, settings] = await Promise.all([
    db
      .select({
        id: sessions.id,
        date: sessions.date,
        startTime: sessions.startTime,
        endTime: sessions.endTime,
        classCode: classes.code,
        className: classes.name,
        attendanceUnlockedUntil: sessions.attendanceUnlockedUntil,
        attendanceCount: sql<number>`(select count(*)::int from ${attendances} where ${attendances.sessionId} = ${sessions.id})`,
      })
      .from(sessions)
      .innerJoin(classes, eq(classes.id, sessions.classId))
      .where(and(...conditions))
      .orderBy(desc(sessions.date), asc(sessions.startTime))
      .limit(100),
    getSettings(),
  ]);
  const today = todayIso(now);
  return rows.map((r) => ({
    ...r,
    locked: isAttendanceLocked({
      sessionDate: r.date,
      today,
      lockDays: settings.attendance_lock_days,
      unlockedUntil: r.attendanceUnlockedUntil,
      now,
    }),
  }));
}
