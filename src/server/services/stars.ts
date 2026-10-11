import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { db, type DbOrTx, type Tx } from "@/db";
import {
  attendances,
  makeupAssignments,
  classes,
  courseSummaries,
  enrollments,
  giftHandovers,
  gifts,
  sessions,
  starCriteria,
  starLogs,
  students,
  user,
} from "@/db/schema";
import { canDeduct, clampTotal } from "@/domain/stars";
import { todayIso } from "@/lib/format";
import type { awardInput, criteriaInput } from "@/lib/validation/stars";
import { audit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, allowedClassIds, assertAdmin, assertCan, assertClassOpen, assertNotTimetableOnly, assertSessionAccess, isAdmin, isTimetableOnly, seesAllClasses } from "../guard";
import { getSettings } from "../settings";
import { sessionRoster } from "./attendance";
import { createRow, deleteRow, updateRow } from "./crud";
import { listClassStudents } from "./students";

// ---------- Tổng sao ----------

/** Tổng sao THÔ toàn thời gian theo học viên (chưa chặn dưới 0); tính khi truy vấn, không lưu cứng. */
async function rawSums(tx: DbOrTx, studentIds: string[]): Promise<Map<string, number>> {
  const out = new Map(studentIds.map((id) => [id, 0]));
  if (studentIds.length === 0) return out;
  const rows = await tx
    .select({ studentId: starLogs.studentId, sum: sql<number>`coalesce(sum(${starLogs.stars}), 0)::int` })
    .from(starLogs)
    .where(inArray(starLogs.studentId, studentIds))
    .groupBy(starLogs.studentId);
  for (const row of rows) out.set(row.studentId, row.sum);
  return out;
}

/** Tổng sao tích lũy (không âm) của nhiều học viên; không kiểm tra quyền — dùng nội bộ. */
export async function starTotalsOf(tx: DbOrTx, studentIds: string[]): Promise<Map<string, number>> {
  const sums = await rawSums(tx, studentIds);
  return new Map([...sums].map(([id, sum]) => [id, clampTotal(sum)]));
}

// ---------- Ngoại lệ của sổ cái chỉ-thêm: xóa sao theo ghi danh, buổi học hoặc học viên bị Admin xóa hẳn ----------

/** Xóa các dòng sao theo id (kèm bản ghi hoàn tác trỏ tới chúng). Trả về số dòng đã xóa. */
async function purgeLogs(tx: Tx, actor: Actor, studentId: string, ids: string[]): Promise<number> {
  assertAdmin(actor);
  if (ids.length === 0) return 0;
  // Trigger ở CSDL chỉ cho DELETE khi cờ này bật; cờ chỉ có hiệu lực trong giao dịch hiện tại và được tắt ngay sau khi xóa.
  await tx.execute(sql`select set_config('haxi.star_logs_admin_delete', 'on', true)`);
  const removed = await tx
    .delete(starLogs)
    .where(and(eq(starLogs.studentId, studentId), or(inArray(starLogs.id, ids), inArray(starLogs.reversesLogId, ids))))
    .returning({ id: starLogs.id });
  await tx.execute(sql`select set_config('haxi.star_logs_admin_delete', 'off', true)`);
  return removed.length;
}

/** Dùng khi Admin xóa một dòng ghi danh nhập sai: xóa lịch sử sao của học viên ở các buổi cho trước (gọi trong transaction đó). */
export async function purgeStudentStarLogs(tx: Tx, actor: Actor, studentId: string, sessionIds: string[]): Promise<number> {
  assertAdmin(actor);
  if (sessionIds.length === 0) return 0;
  const targets = await tx
    .select({ id: starLogs.id })
    .from(starLogs)
    .where(and(eq(starLogs.studentId, studentId), inArray(starLogs.sessionId, sessionIds)));
  return purgeLogs(tx, actor, studentId, targets.map((t) => t.id));
}

/** Dùng khi Admin xóa hẳn một học viên: xóa toàn bộ lịch sử sao của em (gọi trong transaction đó). Trả về số dòng đã xóa. */
export async function purgeAllStudentStarLogs(tx: Tx, actor: Actor, studentId: string): Promise<number> {
  assertAdmin(actor);
  const targets = await tx.select({ id: starLogs.id }).from(starLogs).where(eq(starLogs.studentId, studentId));
  return purgeLogs(tx, actor, studentId, targets.map((t) => t.id));
}

/** Dùng khi Admin xóa hẳn một buổi học: xóa mọi lần ghi sao của buổi. Trả về số dòng đã xóa. */
export async function purgeSessionStarLogs(tx: Tx, actor: Actor, sessionId: string): Promise<number> {
  assertAdmin(actor);
  const rows = await tx.select({ id: starLogs.id, studentId: starLogs.studentId }).from(starLogs).where(eq(starLogs.sessionId, sessionId));
  const byStudent = new Map<string, string[]>();
  for (const r of rows) byStudent.set(r.studentId, [...(byStudent.get(r.studentId) ?? []), r.id]);
  let deleted = 0;
  for (const [studentId, ids] of byStudent) deleted += await purgeLogs(tx, actor, studentId, ids);
  return deleted;
}

// ---------- Tiêu chí sao (Admin quản lý, GV dùng) ----------

export async function listCriteria(actor: Actor, onlyActive = !isAdmin(actor)) {
  return db
    .select()
    .from(starCriteria)
    .where(onlyActive || !isAdmin(actor) ? eq(starCriteria.active, true) : undefined)
    .orderBy(desc(starCriteria.stars), asc(starCriteria.name));
}
export const createCriteria = (actor: Actor, data: z.output<typeof criteriaInput>) =>
  createRow(actor, starCriteria, "star_criteria", data);
/** Sửa tiêu chí không đổi các lần ghi sao cũ (số sao đã được sao chép vào sổ cái). */
export const updateCriteria = (actor: Actor, id: string, data: z.output<typeof criteriaInput>) =>
  updateRow(actor, starCriteria, "star_criteria", id, data);
export const deleteCriteria = (actor: Actor, id: string) => deleteRow(actor, starCriteria, "star_criteria", id);

// ---------- Ghi sao ----------

/** Tổng sao đã trừ của học viên trong buổi, không tính các lần đã hoàn tác. */
async function penaltyUsed(tx: Tx, sessionId: string, studentIds: string[]): Promise<Map<string, number>> {
  const reversal = alias(starLogs, "reversal");
  const rows = await tx
    .select({ studentId: starLogs.studentId, used: sql<number>`coalesce(sum(-${starLogs.stars}), 0)::int` })
    .from(starLogs)
    .leftJoin(reversal, eq(reversal.reversesLogId, starLogs.id))
    .where(
      and(
        eq(starLogs.sessionId, sessionId),
        inArray(starLogs.studentId, studentIds),
        sql`${starLogs.stars} < 0`,
        isNull(starLogs.reversesLogId),
        isNull(reversal.id),
      ),
    )
    .groupBy(starLogs.studentId);
  return new Map(rows.map((r) => [r.studentId, r.used]));
}

export type StarResult = { count: number; stars: number };

/**
 * Ghi sao theo một tiêu chí cho một em / một nhóm / cả lớp trong một transaction.
 * Số sao lấy từ tiêu chí ở máy chủ (client không tự gửi số sao).
 */
export async function awardStars(actor: Actor, input: z.output<typeof awardInput>, now: Date = new Date()): Promise<StarResult> {
  assertCan(actor, "stars", "add");
  await assertSessionAccess(actor, input.sessionId);
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(sessions).where(eq(sessions.id, input.sessionId)).limit(1);
    if (!session) throw notFound("buổi học");
    if (session.status === "cancelled") throw new AppError("CONFLICT", "Buổi đã hủy nên không ghi sao được.");
    if (session.date > todayIso(now)) throw new AppError("CONFLICT", "Chưa đến ngày học.");
    await assertClassOpen(session.classId, tx);
    await assertNotTimetableOnly(session.classId, tx);

    const [criteria] = await tx.select().from(starCriteria).where(eq(starCriteria.id, input.criteriaId)).limit(1);
    if (!criteria || !criteria.active) throw new AppError("VALIDATION", "Tiêu chí không tồn tại hoặc đã ngừng dùng.");

    const studentIds = [...new Set(input.studentIds)];
    const roster = new Map((await sessionRoster(tx, session)).map((r) => [r.studentId, r]));
    if (studentIds.some((id) => !roster.has(id))) {
      throw new AppError("VALIDATION", "Có học viên không thuộc buổi học này.");
    }
    // Khóa dòng học viên để hai lần ghi đồng thời không cùng vượt giới hạn trừ sao.
    await tx.select({ id: students.id }).from(students).where(inArray(students.id, studentIds)).orderBy(asc(students.id)).for("update");

    if (criteria.stars < 0) {
      const { max_deduction_per_session: max } = await getSettings(tx);
      const used = await penaltyUsed(tx, session.id, studentIds);
      const blocked = studentIds.filter((id) => !canDeduct(criteria.stars, used.get(id) ?? 0, max));
      if (blocked.length > 0) {
        const names = blocked.map((id) => roster.get(id)!.fullName).join(", ");
        throw new AppError("CONFLICT", `Mỗi học viên chỉ bị trừ tối đa ${max} sao trong một buổi. Đã vượt giới hạn: ${names}.`);
      }
    }

    const inserted = await tx
      .insert(starLogs)
      .values(
        studentIds.map((studentId) => ({
          sessionId: session.id,
          studentId,
          criteriaId: criteria.id,
          stars: criteria.stars,
          note: input.note,
          recordedBy: actor.userId,
          recordedAt: now,
        })),
      )
      .returning({ id: starLogs.id, studentId: starLogs.studentId });
    for (const log of inserted) {
      await audit(tx, {
        userId: actor.userId,
        action: "star_recorded",
        tableName: "star_logs",
        recordId: log.id,
        newValue: { studentId: log.studentId, sessionId: session.id, criteriaId: criteria.id, stars: criteria.stars },
      });
    }
    return { count: inserted.length, stars: criteria.stars };
  });
}

/** Hoàn tác một lần ghi sao bằng bản ghi đảo dấu (không xóa). Mỗi lần ghi chỉ hoàn tác được một lần. */
export async function undoStarLog(actor: Actor, logId: string, now: Date = new Date()): Promise<StarResult> {
  assertCan(actor, "stars", "edit");
  const [target] = await db.select().from(starLogs).where(eq(starLogs.id, logId)).limit(1);
  // Kiểm tra quyền trước khi tiết lộ bất kỳ thông tin nào về bản ghi.
  if (!target) throw notFound("lần ghi sao");
  if (target.sessionId) await assertSessionAccess(actor, target.sessionId);
  else assertAdmin(actor);

  return db.transaction(async (tx) => {
    await tx.select({ id: students.id }).from(students).where(eq(students.id, target.studentId)).for("update");
    if (target.sessionId) {
      const [session] = await tx.select({ classId: sessions.classId }).from(sessions).where(eq(sessions.id, target.sessionId)).limit(1);
      if (session) await assertClassOpen(session.classId, tx);
    }
    if (target.reversesLogId) throw new AppError("CONFLICT", "Không hoàn tác được một bản ghi hoàn tác.");
    const [already] = await tx.select({ id: starLogs.id }).from(starLogs).where(eq(starLogs.reversesLogId, logId)).limit(1);
    if (already) throw new AppError("CONFLICT", "Lần ghi sao này đã được hoàn tác.");

    const [reversal] = await tx
      .insert(starLogs)
      .values({
        sessionId: target.sessionId,
        studentId: target.studentId,
        criteriaId: target.criteriaId,
        stars: -target.stars,
        note: "Hoàn tác",
        reversesLogId: target.id,
        recordedBy: actor.userId,
        recordedAt: now,
      })
      .returning({ id: starLogs.id });
    await audit(tx, {
      userId: actor.userId,
      action: "star_undone",
      tableName: "star_logs",
      recordId: target.id,
      oldValue: { stars: target.stars, studentId: target.studentId },
      newValue: { reversalId: reversal!.id, stars: -target.stars },
    });
    return { count: 1, stars: -target.stars };
  });
}

// ---------- Truy vấn cho giao diện ----------

/** Phạm vi "lớp của mình": chỉ truy cập học viên đang học lớp mình, hoặc thuộc lớp có buổi mình dạy thay hôm nay. */
export async function assertStudentAccess(actor: Actor, studentId: string, tx: DbOrTx = db, now: Date = new Date()) {
  if (seesAllClasses(actor)) {
    const [row] = await tx.select({ id: students.id }).from(students).where(eq(students.id, studentId)).limit(1);
    if (!row) throw notFound("học viên");
    return;
  }
  if (!actor.teacherId) throw notFound("học viên");
  // Lớp của GV: được phân công hoặc được xếp dạy bên Thời khóa biểu (xem allowedClassIds).
  const mine = (await allowedClassIds(actor, tx)) ?? [];
  const [own] =
    mine.length === 0
      ? []
      : await tx
          .select({ id: enrollments.id })
          .from(enrollments)
          .where(and(eq(enrollments.studentId, studentId), eq(enrollments.status, "active"), inArray(enrollments.classId, mine)))
          .limit(1);
  if (own) return;
  // Học viên lớp khác được xếp học bù vào một buổi của lớp mình.
  const [guest] =
    mine.length === 0
      ? []
      : await tx
          .select({ id: makeupAssignments.id })
          .from(makeupAssignments)
          .innerJoin(sessions, eq(sessions.id, makeupAssignments.makeupSessionId))
          .where(and(eq(makeupAssignments.studentId, studentId), inArray(sessions.classId, mine), ne(sessions.status, "cancelled")))
          .limit(1);
  if (guest) return;
  const [covering] = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(enrollments, and(eq(enrollments.classId, sessions.classId), eq(enrollments.studentId, studentId), eq(enrollments.status, "active")))
    .where(and(eq(sessions.substituteTeacherId, actor.teacherId), eq(sessions.date, todayIso(now)), eq(sessions.status, "planned")))
    .limit(1);
  if (!covering) throw notFound("học viên");
}

const reversal = alias(starLogs, "reversal");
const logColumns = {
  id: starLogs.id,
  studentId: starLogs.studentId,
  studentName: students.fullName,
  studentCode: students.code,
  sessionId: starLogs.sessionId,
  sessionDate: sessions.date,
  classCode: classes.code,
  criteriaName: starCriteria.name,
  stars: starLogs.stars,
  note: starLogs.note,
  recordedAt: starLogs.recordedAt,
  recordedByName: user.name,
  isReversal: sql<boolean>`${starLogs.reversesLogId} is not null`,
  reversed: sql<boolean>`${reversal.id} is not null`,
};

function logQuery() {
  return db
    .select(logColumns)
    .from(starLogs)
    .innerJoin(students, eq(students.id, starLogs.studentId))
    .leftJoin(sessions, eq(sessions.id, starLogs.sessionId))
    .leftJoin(classes, eq(classes.id, sessions.classId))
    .leftJoin(starCriteria, eq(starCriteria.id, starLogs.criteriaId))
    .leftJoin(user, eq(user.id, starLogs.recordedBy))
    .leftJoin(reversal, eq(reversal.reversesLogId, starLogs.id));
}

export type StarLogRow = Awaited<ReturnType<typeof logQuery>>[number];

/** Bảng ghi sao của một buổi: danh sách học viên kèm tổng sao, tiêu chí đang dùng và sổ cái của buổi. */
export async function getSessionStarBoard(actor: Actor, sessionId: string) {
  assertCan(actor, "stars", "view");
  await assertSessionAccess(actor, sessionId);
  const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  // Buổi của lớp chỉ hiển thị trên Thời khóa biểu không có bảng ghi sao.
  if (!session || (await isTimetableOnly(session.classId))) throw notFound("buổi học");
  const roster = await sessionRoster(db, session);
  const ids = roster.map((r) => r.studentId);
  const [totals, logs, criteria, settings] = await Promise.all([
    starTotalsOf(db, ids),
    logQuery().where(eq(starLogs.sessionId, sessionId)).orderBy(desc(starLogs.recordedAt), desc(starLogs.id)),
    listCriteria(actor, true),
    getSettings(),
  ]);
  const net = new Map<string, number>();
  for (const log of logs) net.set(log.studentId, (net.get(log.studentId) ?? 0) + log.stars);
  return {
    maxDeduction: settings.max_deduction_per_session,
    criteria,
    logs,
    students: roster.map((r) => ({ ...r, total: totals.get(r.studentId) ?? 0, sessionStars: net.get(r.studentId) ?? 0 })),
  };
}

/** Học viên đang học của lớp kèm tổng sao tích lũy. */
export async function listClassStars(actor: Actor, classId: string) {
  // listClassStudents kiểm tra quyền theo lớp.
  const list = await listClassStudents(actor, classId);
  const totals = await starTotalsOf(db, list.map((s) => s.id));
  return list.map((s) => ({ ...s, total: totals.get(s.id) ?? 0 }));
}

/** Hồ sơ sao của một học viên: lịch sử ghi sao, điểm danh và quà tổng kết. */
export async function getStudentStarProfile(actor: Actor, studentId: string) {
  await assertStudentAccess(actor, studentId);
  // Buổi học và quà chỉ lấy trong các lớp thuộc phạm vi của người xem (Admin, phạm vi "Tất cả lớp": mọi lớp).
  const allowed = await allowedClassIds(actor);
  const inScope = (column: typeof sessions.classId | typeof courseSummaries.classId) =>
    allowed === null ? undefined : allowed.length === 0 ? sql`false` : inArray(column, allowed);
  const [[student], attendance, giftRows] = await Promise.all([
    db.select({ id: students.id, code: students.code, fullName: students.fullName }).from(students).where(eq(students.id, studentId)).limit(1),
    db
      .select({
        sessionId: sessions.id,
        date: sessions.date,
        startTime: sessions.startTime,
        classCode: classes.code,
        status: attendances.status,
        stars: sql<number>`coalesce((select sum(l.stars) from star_logs l where l.session_id = ${sessions.id} and l.student_id = ${attendances.studentId}), 0)::int`,
      })
      .from(attendances)
      .innerJoin(sessions, eq(sessions.id, attendances.sessionId))
      .innerJoin(classes, eq(classes.id, sessions.classId))
      .where(and(eq(attendances.studentId, studentId), ne(sessions.status, "cancelled"), inScope(sessions.classId)))
      .orderBy(desc(sessions.date), desc(sessions.startTime))
      .limit(100),
    db
      .select({
        id: giftHandovers.id,
        giftName: gifts.name,
        classCode: classes.code,
        status: giftHandovers.status,
        givenAt: giftHandovers.givenAt,
      })
      .from(giftHandovers)
      .innerJoin(courseSummaries, eq(courseSummaries.id, giftHandovers.summaryId))
      .innerJoin(gifts, eq(gifts.id, giftHandovers.giftId))
      .innerJoin(classes, eq(classes.id, courseSummaries.classId))
      .where(and(eq(courseSummaries.studentId, studentId), inScope(courseSummaries.classId)))
      .orderBy(desc(courseSummaries.finalizedAt)),
  ]);
  return { student: student!, attendance, gifts: giftRows };
}

/** Sổ cái gần đây: toàn trung tâm, hoặc chỉ các lớp trong phạm vi của người xem. */
export async function listRecentStarLogs(actor: Actor, limit = 200) {
  assertCan(actor, "stars", "view");
  const allowed = await allowedClassIds(actor);
  if (allowed && allowed.length === 0) return [];
  return logQuery()
    .where(allowed ? inArray(sessions.classId, allowed) : undefined)
    .orderBy(desc(starLogs.recordedAt), desc(starLogs.id)).limit(limit);
}
