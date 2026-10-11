import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { z } from "zod";
import { db, type DbOrTx } from "@/db";
import {
  attendances,
  classes,
  courseSummaries,
  enrollments,
  giftHandovers,
  gifts,
  rewardTiers,
  sessionStudents,
  sessions,
  starLogs,
  students,
  user,
} from "@/db/schema";
import { type AttendanceCounts, type AttendanceStatus, type RewardTier, attendanceOf, classStarTotal, pickTier, rankByStars } from "@/domain/summary";
import { todayIso } from "@/lib/format";
import type { giftInput, tierInput } from "@/lib/validation/rewards";
import { audit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, TIMETABLE_ONLY_MESSAGE, assertCan, assertClassAccess, isTimetableOnly } from "../guard";
import { createRow, deleteRow, updateRow } from "./crud";

// ---------- Số liệu lớp: tổng sao theo lớp, chuyên cần, xếp hạng ----------

export type ClassStatRow = {
  studentId: string;
  code: string;
  fullName: string;
  totalStars: number;
  attendance: AttendanceCounts;
  rank: number;
};

/** Tính trực tiếp từ sổ cái và điểm danh (không lưu cứng). Chỉ gồm học viên đang ghi danh lớp. */
export async function computeClassStats(tx: DbOrTx, classId: string): Promise<ClassStatRow[]> {
  const [enrollmentRows, sessionRows, starRows] = await Promise.all([
    tx
      .select({
        studentId: students.id,
        code: students.code,
        fullName: students.fullName,
        joinedAt: enrollments.joinedAt,
        leftAt: enrollments.leftAt,
        status: enrollments.status,
      })
      .from(enrollments)
      .innerJoin(students, eq(students.id, enrollments.studentId))
      .where(eq(enrollments.classId, classId)),
    tx.select({ id: sessions.id, date: sessions.date, kind: sessions.kind, status: sessions.status }).from(sessions).where(eq(sessions.classId, classId)),
    // Tổng sao THEO LỚP: chỉ các lần ghi trong buổi của lớp này.
    tx
      .select({ studentId: starLogs.studentId, sum: sql<number>`coalesce(sum(${starLogs.stars}), 0)::int` })
      .from(starLogs)
      .innerJoin(sessions, eq(sessions.id, starLogs.sessionId))
      .where(eq(sessions.classId, classId))
      .groupBy(starLogs.studentId),
  ]);
  const sessionIds = sessionRows.map((s) => s.id);
  const [attendanceRows, makeupRows] =
    sessionIds.length === 0
      ? [[], []]
      : await Promise.all([
          tx
            .select({ sessionId: attendances.sessionId, studentId: attendances.studentId, status: attendances.status })
            .from(attendances)
            .where(inArray(attendances.sessionId, sessionIds)),
          tx.select().from(sessionStudents).where(inArray(sessionStudents.sessionId, sessionIds)),
        ]);

  const makeup = new Map<string, Set<string>>();
  for (const m of makeupRows) makeup.set(m.sessionId, (makeup.get(m.sessionId) ?? new Set()).add(m.studentId));
  const taught = sessionRows.map((s) => ({ ...s, studentIds: makeup.get(s.id) }));
  const statusOf = new Map<string, Map<string, AttendanceStatus>>();
  for (const a of attendanceRows) statusOf.set(a.studentId, (statusOf.get(a.studentId) ?? new Map()).set(a.sessionId, a.status));
  const stars = new Map(starRows.map((r) => [r.studentId, r.sum]));

  const current = new Map<string, { code: string; fullName: string }>();
  for (const e of enrollmentRows) if (e.status === "active") current.set(e.studentId, { code: e.code, fullName: e.fullName });

  const rows = [...current].map(([studentId, info]) => ({
    studentId,
    ...info,
    totalStars: classStarTotal(stars.get(studentId) ?? 0),
    attendance: attendanceOf(
      studentId,
      enrollmentRows.filter((e) => e.studentId === studentId),
      taught,
      statusOf.get(studentId) ?? new Map(),
    ),
  }));
  return rankByStars(rows).sort((a, b) => a.rank - b.rank || a.fullName.localeCompare(b.fullName, "vi"));
}

/** Báo cáo lớp: Admin xem mọi lớp, GV chỉ xem lớp mình. */
export async function getClassReport(actor: Actor, classId: string) {
  await assertClassAccess(actor, classId);
  if (await isTimetableOnly(classId)) throw notFound("lớp học");
  const [cls] = await db
    .select({ id: classes.id, code: classes.code, name: classes.name, status: classes.status })
    .from(classes)
    .where(eq(classes.id, classId))
    .limit(1);
  if (!cls) throw notFound("lớp học");
  const [rows, [counts]] = await Promise.all([
    computeClassStats(db, classId),
    db
      .select({
        done: sql<number>`count(*) filter (where ${sessions.status} = 'done')::int`,
        cancelled: sql<number>`count(*) filter (where ${sessions.status} = 'cancelled')::int`,
        planned: sql<number>`count(*) filter (where ${sessions.status} = 'planned')::int`,
      })
      .from(sessions)
      .where(eq(sessions.classId, classId)),
  ]);
  return { class: cls, sessions: counts ?? { done: 0, cancelled: 0, planned: 0 }, rows };
}

// ---------- Đóng lớp và chốt tổng kết ----------

/**
 * Đóng lớp: chốt course_summaries (ảnh chụp tổng sao khóa, tỷ lệ chuyên cần, xếp hạng).
 * Buổi đã qua mà chưa điểm danh phải được xử lý trước; buổi tương lai còn lại được hủy.
 */
export async function closeClass(actor: Actor, classId: string, now: Date = new Date()) {
  assertCan(actor, "rewards", "edit");
  await assertClassAccess(actor, classId);
  return db.transaction(async (tx) => {
    const [cls] = await tx.select().from(classes).where(eq(classes.id, classId)).for("update").limit(1);
    if (!cls) throw notFound("lớp học");
    if (cls.status !== "open") throw new AppError("CONFLICT", "Lớp này đã đóng.");
    if (cls.timetableOnly) throw new AppError("CONFLICT", TIMETABLE_ONLY_MESSAGE);
    const today = todayIso(now);

    const [pending] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(sessions)
      .where(and(eq(sessions.classId, classId), eq(sessions.status, "planned"), lte(sessions.date, today)));
    if ((pending?.n ?? 0) > 0) {
      throw new AppError("CONFLICT", `Còn ${pending!.n} buổi đã qua chưa điểm danh. Hãy điểm danh hoặc hủy các buổi đó trước khi đóng lớp.`);
    }
    const cancelled = await tx
      .update(sessions)
      .set({ status: "cancelled", note: "Hủy do lớp đóng", updatedAt: now })
      .where(and(eq(sessions.classId, classId), eq(sessions.status, "planned"), gt(sessions.date, today)))
      .returning({ id: sessions.id });

    const stats = await computeClassStats(tx, classId);
    await tx.delete(courseSummaries).where(eq(courseSummaries.classId, classId));
    if (stats.length > 0) {
      await tx.insert(courseSummaries).values(
        stats.map((s) => ({
          classId,
          studentId: s.studentId,
          totalStars: s.totalStars,
          attendanceRate: s.attendance.rate.toFixed(2),
          rank: s.rank,
          finalizedAt: now,
        })),
      );
    }
    await tx.update(classes).set({ status: "closed", updatedAt: now }).where(eq(classes.id, classId));
    await audit(tx, {
      userId: actor.userId,
      action: "class_closed",
      tableName: "classes",
      recordId: classId,
      newValue: { summaries: stats.length, cancelledFutureSessions: cancelled.length },
    });
    return { summaries: stats.length, cancelledFutureSessions: cancelled.length };
  });
}

// ---------- Quà tặng và mốc quà ----------

export async function listGifts(actor: Actor) {
  assertCan(actor, "rewards", "view");
  return db.select().from(gifts).orderBy(asc(gifts.name));
}
export const createGift = (actor: Actor, data: z.output<typeof giftInput>) => createRow(actor, gifts, "gifts", data, "rewards");
export const updateGift = (actor: Actor, id: string, data: z.output<typeof giftInput>) => updateRow(actor, gifts, "gifts", id, data, "rewards");
export const deleteGift = (actor: Actor, id: string) => deleteRow(actor, gifts, "gifts", id);

export async function listTiers(actor: Actor) {
  assertCan(actor, "rewards", "view");
  return db
    .select({
      id: rewardTiers.id,
      minStars: rewardTiers.minStars,
      giftName: gifts.name,
      classCode: classes.code,
      className: classes.name,
    })
    .from(rewardTiers)
    .innerJoin(gifts, eq(gifts.id, rewardTiers.giftId))
    .innerJoin(classes, eq(classes.id, rewardTiers.classId))
    .orderBy(asc(classes.code), asc(rewardTiers.minStars));
}
export const createTier = (actor: Actor, data: z.output<typeof tierInput>) => createRow(actor, rewardTiers, "reward_tiers", data, "rewards");
export const deleteTier = (actor: Actor, id: string) => deleteRow(actor, rewardTiers, "reward_tiers", id);

/** Mốc quà của một lớp (mốc quà chỉ đặt theo lớp). */
export async function tiersFor(tx: DbOrTx, cls: { id: string }): Promise<RewardTier[]> {
  return tx.select().from(rewardTiers).where(eq(rewardTiers.classId, cls.id));
}

// ---------- Đề xuất, duyệt và trao quà ----------

export type RewardRow = {
  summaryId: string;
  studentId: string;
  code: string;
  fullName: string;
  totalStars: number;
  attendanceRate: number;
  rank: number;
  /** Quà hệ thống đề xuất theo mốc; null = chưa đạt mốc nào. */
  proposedGift: { id: string; name: string } | null;
  handover: { id: string; giftName: string; status: "pending" | "given"; givenAt: Date | null; givenByName: string | null } | null;
};

export type GiftNeed = { giftId: string; name: string; eligible: number; approved: number; given: number; stock: number; missing: number };

/** Bảng tổng kết đã chốt của lớp: xếp hạng, quà đề xuất theo mốc, trạng thái duyệt/trao, số quà cần chuẩn bị. */
export async function getClassSummary(actor: Actor, classId: string) {
  assertCan(actor, "rewards", "view");
  await assertClassAccess(actor, classId);
  if (await isTimetableOnly(classId)) throw notFound("lớp học");
  const [cls] = await db
    .select({ id: classes.id, code: classes.code, name: classes.name, status: classes.status })
    .from(classes)
    .where(eq(classes.id, classId))
    .limit(1);
  if (!cls) throw notFound("lớp học");

  const [summaryRows, tiers, giftRows] = await Promise.all([
    db
      .select({
        summaryId: courseSummaries.id,
        studentId: students.id,
        code: students.code,
        fullName: students.fullName,
        totalStars: courseSummaries.totalStars,
        attendanceRate: courseSummaries.attendanceRate,
        rank: courseSummaries.rank,
        finalizedAt: courseSummaries.finalizedAt,
        handoverId: giftHandovers.id,
        handoverGiftId: giftHandovers.giftId,
        handoverStatus: giftHandovers.status,
        givenAt: giftHandovers.givenAt,
        givenByName: user.name,
      })
      .from(courseSummaries)
      .innerJoin(students, eq(students.id, courseSummaries.studentId))
      .leftJoin(giftHandovers, eq(giftHandovers.summaryId, courseSummaries.id))
      .leftJoin(user, eq(user.id, giftHandovers.givenBy))
      .where(eq(courseSummaries.classId, classId))
      .orderBy(asc(courseSummaries.rank), asc(students.fullName)),
    tiersFor(db, cls),
    db.select().from(gifts),
  ]);
  const giftById = new Map(giftRows.map((g) => [g.id, g]));

  const rows: RewardRow[] = summaryRows.map((s) => {
    const tier = pickTier(s.totalStars, tiers, classId);
    const proposed = tier ? giftById.get(tier.giftId) : undefined;
    return {
      summaryId: s.summaryId,
      studentId: s.studentId,
      code: s.code,
      fullName: s.fullName,
      totalStars: s.totalStars,
      attendanceRate: Number(s.attendanceRate),
      rank: s.rank,
      proposedGift: proposed ? { id: proposed.id, name: proposed.name } : null,
      handover:
        s.handoverId && s.handoverStatus
          ? {
              id: s.handoverId,
              giftName: giftById.get(s.handoverGiftId!)?.name ?? "?",
              status: s.handoverStatus,
              givenAt: s.givenAt,
              givenByName: s.givenByName,
            }
          : null,
    };
  });

  const needs = new Map<string, GiftNeed>();
  const need = (giftId: string) => {
    const gift = giftById.get(giftId);
    if (!needs.has(giftId)) needs.set(giftId, { giftId, name: gift?.name ?? "?", eligible: 0, approved: 0, given: 0, stock: gift?.stock ?? 0, missing: 0 });
    return needs.get(giftId)!;
  };
  for (const s of summaryRows) {
    const tier = pickTier(s.totalStars, tiers, classId);
    if (tier) need(tier.giftId).eligible++;
    if (s.handoverGiftId) {
      need(s.handoverGiftId).approved++;
      if (s.handoverStatus === "given") need(s.handoverGiftId).given++;
    }
  }
  // Số quà còn phải trao so với tồn kho hiện tại.
  for (const n of needs.values()) n.missing = Math.max(0, n.approved - n.given - n.stock);

  return {
    class: cls,
    finalizedAt: summaryRows[0]?.finalizedAt ?? null,
    rows,
    giftNeeds: [...needs.values()].sort((a, b) => a.name.localeCompare(b.name, "vi")),
  };
}

/** Admin duyệt danh sách nhận quà: quà do máy chủ xác định theo mốc, client chỉ chọn học viên. */
export async function approveRewards(actor: Actor, classId: string, summaryIds: string[]) {
  assertCan(actor, "rewards", "edit");
  await assertClassAccess(actor, classId);
  return db.transaction(async (tx) => {
    const [cls] = await tx.select().from(classes).where(eq(classes.id, classId)).limit(1);
    if (!cls) throw notFound("lớp học");
    if (cls.status !== "closed") throw new AppError("CONFLICT", "Chỉ duyệt quà sau khi đã đóng lớp và chốt tổng kết.");
    const ids = [...new Set(summaryIds)];
    const summaries = await tx.select().from(courseSummaries).where(and(eq(courseSummaries.classId, classId), inArray(courseSummaries.id, ids)));
    if (summaries.length !== ids.length) throw new AppError("VALIDATION", "Có học viên không thuộc tổng kết của lớp này.");
    const tiers = await tiersFor(tx, cls);

    let approved = 0;
    for (const summary of summaries) {
      const tier = pickTier(summary.totalStars, tiers, classId);
      if (!tier) throw new AppError("VALIDATION", "Có học viên chưa đạt mốc quà nào.");
      const [row] = await tx
        .insert(giftHandovers)
        .values({ summaryId: summary.id, giftId: tier.giftId, status: "pending" })
        .onConflictDoNothing()
        .returning();
      if (!row) continue; // đã duyệt trước đó
      approved++;
      await audit(tx, {
        userId: actor.userId,
        action: "reward_approved",
        tableName: "gift_handovers",
        recordId: row.id,
        newValue: { summaryId: summary.id, giftId: tier.giftId },
      });
    }
    return { approved };
  });
}

/** Lượt trao quà phải thuộc một lớp trong phạm vi của người thao tác. */
async function assertHandoverAccess(actor: Actor, summaryId: string, tx: DbOrTx) {
  const [summary] = await tx.select({ classId: courseSummaries.classId }).from(courseSummaries).where(eq(courseSummaries.id, summaryId)).limit(1);
  if (!summary) throw notFound("lượt trao quà");
  await assertClassAccess(actor, summary.classId, tx);
}

/** Ghi nhận đã trao quà: lưu ngày và người trao, trừ tồn kho. */
export async function markGiftGiven(actor: Actor, handoverId: string, now: Date = new Date()) {
  assertCan(actor, "rewards", "edit");
  return db.transaction(async (tx) => {
    const [handover] = await tx.select().from(giftHandovers).where(eq(giftHandovers.id, handoverId)).for("update").limit(1);
    if (!handover) throw notFound("lượt trao quà");
    await assertHandoverAccess(actor, handover.summaryId, tx);
    if (handover.status === "given") throw new AppError("CONFLICT", "Quà này đã được ghi nhận trao.");
    const [gift] = await tx.select().from(gifts).where(eq(gifts.id, handover.giftId)).for("update").limit(1);
    if (!gift || gift.stock < 1) throw new AppError("CONFLICT", `Kho đã hết quà "${gift?.name ?? "?"}". Hãy cập nhật tồn kho trước.`);
    await tx.update(gifts).set({ stock: gift.stock - 1 }).where(eq(gifts.id, gift.id));
    const [row] = await tx
      .update(giftHandovers)
      .set({ status: "given", givenAt: now, givenBy: actor.userId })
      .where(eq(giftHandovers.id, handoverId))
      .returning();
    await audit(tx, { userId: actor.userId, action: "gift_given", tableName: "gift_handovers", recordId: handoverId, oldValue: handover, newValue: row });
    return row!;
  });
}

/** Bỏ duyệt một lượt quà chưa trao. */
export async function cancelApproval(actor: Actor, handoverId: string) {
  assertCan(actor, "rewards", "edit");
  return db.transaction(async (tx) => {
    const [handover] = await tx.select().from(giftHandovers).where(eq(giftHandovers.id, handoverId)).for("update").limit(1);
    if (!handover) throw notFound("lượt trao quà");
    await assertHandoverAccess(actor, handover.summaryId, tx);
    if (handover.status === "given") throw new AppError("CONFLICT", "Quà đã trao nên không bỏ duyệt được.");
    await tx.delete(giftHandovers).where(eq(giftHandovers.id, handoverId));
    await audit(tx, { userId: actor.userId, action: "reward_approval_cancelled", tableName: "gift_handovers", recordId: handoverId, oldValue: handover });
  });
}
