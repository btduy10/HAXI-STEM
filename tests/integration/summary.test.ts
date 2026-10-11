import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLogs, classes, courseSummaries, enrollments, gifts, rewardTiers, sessions, starCriteria, starLogs } from "@/db/schema";
import { renderExport } from "@/server/export";
import { getSettings } from "@/server/settings";
import * as attendance from "@/server/services/attendance";
import * as classSvc from "@/server/services/classes";
import * as reports from "@/server/services/reports";
import * as stars from "@/server/services/stars";
import * as summaries from "@/server/services/summaries";
import { type Fixture, resetDb, seedFixture } from "./helpers";

let f: Fixture;
let s1: typeof sessions.$inferSelect;
let s2: typeof sessions.$inferSelect;
let plus3 = "";
const now = new Date("2026-01-21T05:00:00Z");
const a1 = () => f.students[0]!.id;
const a2 = () => f.students[1]!.id;

/**
 * Lớp A: buổi 06/01 và 13/01 đã dạy, 20/01 hủy, 27/01 chưa tới.
 * A1 có mặt cả hai buổi (6 sao trong lớp + 20 sao ở lớp khác); A2 có mặt một buổi, vắng một buổi (3 sao).
 */
beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  const [criteria] = await db.insert(starCriteria).values({ name: "+3", stars: 3, type: "reward" }).returning();
  plus3 = criteria!.id;
  const base = { classId: f.classA.id, startTime: "08:00", endTime: "09:30", teacherId: f.teacherA.id };
  [s1, s2] = (await db
    .insert(sessions)
    .values([
      { ...base, date: "2026-01-06" },
      { ...base, date: "2026-01-13" },
      { ...base, date: "2026-01-20", status: "cancelled" },
      { ...base, date: "2026-01-27" },
    ])
    .returning()) as [typeof sessions.$inferSelect, typeof sessions.$inferSelect];
  const entry = (studentId: string, status: "present" | "absent") => ({ studentId, status, note: null });
  await attendance.saveAttendance(f.actorA, { sessionId: s1.id, content: null, entries: [entry(a1(), "present"), entry(a2(), "present")] }, new Date("2026-01-06T05:00:00Z"));
  await attendance.saveAttendance(f.actorA, { sessionId: s2.id, content: null, entries: [entry(a1(), "present"), entry(a2(), "absent")] }, new Date("2026-01-13T05:00:00Z"));
  await stars.awardStars(f.actorA, { sessionId: s1.id, criteriaId: plus3, studentIds: [a1(), a2()], note: null }, now);
  await stars.awardStars(f.actorA, { sessionId: s2.id, criteriaId: plus3, studentIds: [a1()], note: null }, now);
  // Sao A1 nhận ở một buổi của lớp B không được tính vào tổng của lớp A.
  const [other] = await db.insert(sessions).values({ classId: f.classB.id, date: "2026-01-07", startTime: "08:00", endTime: "09:30", status: "done" }).returning();
  await db.insert(starLogs).values({ sessionId: other!.id, studentId: a1(), stars: 20 });
});

const close = () => summaries.closeClass(f.admin, f.classA.id, now);

describe("báo cáo lớp", () => {
  it("tổng sao theo lớp, chuyên cần trên buổi đã dạy, xếp hạng", async () => {
    const report = await summaries.getClassReport(f.actorA, f.classA.id);
    expect(report.sessions).toEqual({ done: 2, cancelled: 1, planned: 1 });
    expect(report.rows.map((r) => [r.code, r.rank, r.totalStars, r.attendance.taught, r.attendance.rate])).toEqual([
      ["A1", 1, 6, 2, 100],
      ["A2", 2, 3, 2, 50],
    ]);
    // Tổng toàn thời gian của A1 khác tổng theo lớp (dùng xếp hạng, tặng quà).
    expect((await stars.starTotalsOf(db, [a1()])).get(a1())).toBe(26);
  });

  it("GV chỉ xem được số liệu lớp mình; không xuất được tổng kết", async () => {
    await expect(summaries.getClassReport(f.actorB, f.classA.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(reports.summaryDoc(f.actorA, f.classA.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("TKB xuất ra của GV chỉ gồm buổi của mình", async () => {
    const range = { from: "2026-01-01", to: "2026-01-31" };
    const mine = await reports.timetableDoc(f.actorA, { ...range, personal: true });
    expect(mine.sections[0]!.rows).toHaveLength(4);
    expect(mine.sections[0]!.rows.every((r) => String(r[3]).startsWith("A "))).toBe(true);
    expect((await reports.timetableDoc(f.actorB, { ...range, classId: f.classA.id, personal: true })).sections[0]!.rows).toHaveLength(0);
    expect((await reports.timetableDoc(f.admin, range)).sections[0]!.rows).toHaveLength(5);
  });
});

describe("đóng lớp và chốt tổng kết", () => {
  it("chỉ Admin; phải xử lý buổi đã qua chưa điểm danh trước", async () => {
    await expect(summaries.closeClass(f.actorA, f.classA.id, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(summaries.closeClass(f.admin, f.classA.id, new Date("2026-01-28T05:00:00Z"))).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("1 buổi đã qua chưa điểm danh"),
    });
    expect((await db.select().from(classes).where(eq(classes.id, f.classA.id)))[0]!.status).toBe("open");
  });

  it("chốt ảnh chụp tổng sao khóa, chuyên cần, xếp hạng; hủy buổi tương lai; không đóng hai lần", async () => {
    expect(await close()).toEqual({ summaries: 2, cancelledFutureSessions: 1 });
    const rows = await db.select().from(courseSummaries).where(eq(courseSummaries.classId, f.classA.id)).orderBy(courseSummaries.rank);
    expect(rows.map((r) => [r.studentId, r.totalStars, r.attendanceRate, r.rank])).toEqual([
      [a1(), 6, "100.00", 1],
      [a2(), 3, "50.00", 2],
    ]);
    const left = await db.select().from(sessions).where(eq(sessions.classId, f.classA.id));
    expect(left.filter((s) => s.status === "planned")).toEqual([]);
    await expect(close()).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("sau khi đóng: không điểm danh, ghi sao, hoàn tác hay ghi danh thêm", async () => {
    await close();
    const closed = { code: "CONFLICT" };
    await expect(
      attendance.saveAttendance(f.actorA, { sessionId: s2.id, content: null, entries: [a1(), a2()].map((studentId) => ({ studentId, status: "present" as const, note: null })) }, new Date("2026-01-14T05:00:00Z")),
    ).rejects.toMatchObject(closed);
    await expect(stars.awardStars(f.admin, { sessionId: s1.id, criteriaId: plus3, studentIds: [a1()], note: null }, now)).rejects.toMatchObject(closed);
    const [log] = await db.select().from(starLogs).where(eq(starLogs.sessionId, s1.id));
    await expect(stars.undoStarLog(f.admin, log!.id, now)).rejects.toMatchObject(closed);
    await expect(classSvc.enrollStudent(f.admin, { classId: f.classA.id, studentId: f.students[4]!.id, joinedAt: "2026-01-21" })).rejects.toMatchObject(closed);
    const summary = await summaries.getClassSummary(f.admin, f.classA.id);
    expect(summary.rows.map((r) => r.totalStars)).toEqual([6, 3]);
  });
});

describe("mốc quà, duyệt và trao quà", () => {
  let sticker: typeof gifts.$inferSelect;
  let kit: typeof gifts.$inferSelect;

  beforeEach(async () => {
    [sticker, kit] = (await db
      .insert(gifts)
      .values([
        { name: "Sticker", stock: 5 },
        { name: "Bộ lắp ráp", stock: 1 },
      ])
      .returning()) as [typeof gifts.$inferSelect, typeof gifts.$inferSelect];
    // Mốc quà đặt theo lớp (lớp không còn gắn với khóa học).
    await db.insert(rewardTiers).values([
      { classId: f.classA.id, minStars: 3, giftId: sticker.id },
      { classId: f.classA.id, minStars: 6, giftId: kit.id },
    ]);
  });

  it("đề xuất theo mốc cao nhất đạt được; mốc quà của lớp khác không áp dụng", async () => {
    await close();
    let summary = await summaries.getClassSummary(f.admin, f.classA.id);
    expect(summary.rows.map((r) => [r.code, r.proposedGift?.name ?? null])).toEqual([["A1", "Bộ lắp ráp"], ["A2", "Sticker"]]);
    expect(summary.giftNeeds).toMatchObject([
      { name: "Bộ lắp ráp", eligible: 1, approved: 0, given: 0, stock: 1, missing: 0 },
      { name: "Sticker", eligible: 1, approved: 0 },
    ]);
    // Mốc của lớp B (1 sao đã được Bộ lắp ráp) không đổi đề xuất của lớp A.
    await summaries.createTier(f.admin, { classId: f.classB.id, minStars: 1, giftId: kit.id });
    summary = await summaries.getClassSummary(f.admin, f.classA.id);
    expect(summary.rows.map((r) => r.proposedGift?.name ?? null)).toEqual(["Bộ lắp ráp", "Sticker"]);
    // Thêm mốc cao hơn cho lớp A: em đạt mốc đó được đề xuất quà của mốc mới.
    await summaries.createTier(f.admin, { classId: f.classA.id, minStars: 5, giftId: sticker.id });
    await db.delete(rewardTiers).where(eq(rewardTiers.minStars, 6));
    summary = await summaries.getClassSummary(f.admin, f.classA.id);
    expect(summary.rows.map((r) => r.proposedGift?.name ?? null)).toEqual(["Sticker", "Sticker"]);
    expect((await summaries.listTiers(f.admin)).map((t) => `${t.classCode}:${t.minStars}`)).toEqual(["A:3", "A:5", "B:1"]);
  });

  it("duyệt: chỉ Admin, chỉ sau khi đóng lớp, quà do máy chủ xác định, không duyệt trùng", async () => {
    const preClose = await summaries.getClassSummary(f.admin, f.classA.id);
    expect(preClose.rows).toEqual([]);
    await expect(summaries.approveRewards(f.admin, f.classA.id, ["00000000-0000-4000-8000-000000000000"])).rejects.toMatchObject({ code: "CONFLICT" });
    await close();
    const { rows } = await summaries.getClassSummary(f.admin, f.classA.id);
    const ids = rows.map((r) => r.summaryId);
    await expect(summaries.approveRewards(f.actorA, f.classA.id, ids)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(summaries.approveRewards(f.admin, f.classB.id, ids)).rejects.toMatchObject({ code: "CONFLICT" }); // lớp B chưa đóng
    expect(await summaries.approveRewards(f.admin, f.classA.id, ids)).toEqual({ approved: 2 });
    expect(await summaries.approveRewards(f.admin, f.classA.id, ids)).toEqual({ approved: 0 });
    const after = await summaries.getClassSummary(f.admin, f.classA.id);
    expect(after.rows.map((r) => [r.handover?.giftName, r.handover?.status])).toEqual([["Bộ lắp ráp", "pending"], ["Sticker", "pending"]]);
  });

  it("trao quà: lưu ngày và người trao, trừ tồn kho, chặn khi hết kho hoặc trao hai lần", async () => {
    await close();
    const before = await summaries.getClassSummary(f.admin, f.classA.id);
    await summaries.approveRewards(f.admin, f.classA.id, before.rows.map((r) => r.summaryId));
    const approved = await summaries.getClassSummary(f.admin, f.classA.id);
    const kitHandover = approved.rows[0]!.handover!;
    const stickerHandover = approved.rows[1]!.handover!;

    await expect(summaries.markGiftGiven(f.actorA, kitHandover.id, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const given = await summaries.markGiftGiven(f.admin, kitHandover.id, now);
    expect(given).toMatchObject({ status: "given", givenBy: f.admin.userId, givenAt: now });
    expect((await db.select().from(gifts).where(eq(gifts.id, kit.id)))[0]!.stock).toBe(0);
    await expect(summaries.markGiftGiven(f.admin, kitHandover.id, now)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(summaries.cancelApproval(f.admin, kitHandover.id)).rejects.toMatchObject({ code: "CONFLICT" });

    await db.update(gifts).set({ stock: 0 }).where(eq(gifts.id, sticker.id));
    await expect(summaries.markGiftGiven(f.admin, stickerHandover.id, now)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("hết quà") });
    const needs = (await summaries.getClassSummary(f.admin, f.classA.id)).giftNeeds;
    expect(needs).toMatchObject([
      { name: "Bộ lắp ráp", approved: 1, given: 1, stock: 0, missing: 0 },
      { name: "Sticker", approved: 1, given: 0, stock: 0, missing: 1 },
    ]);
    await summaries.cancelApproval(f.admin, stickerHandover.id);
    expect((await summaries.getClassSummary(f.admin, f.classA.id)).rows[1]!.handover).toBeNull();
    const actions = (await db.select().from(auditLogs)).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["class_closed", "reward_approved", "gift_given", "reward_approval_cancelled"]));
  });

  it("xuất tổng kết ra Excel và PDF có dấu tiếng Việt", async () => {
    await close();
    const doc = await reports.summaryDoc(f.admin, f.classA.id);
    const workbook = new ExcelJS.Workbook();
    const xlsx = await renderExport(doc, "xlsx");
    await workbook.xlsx.load(xlsx.buffer.slice(xlsx.byteOffset, xlsx.byteOffset + xlsx.byteLength) as ArrayBuffer);
    expect(workbook.worksheets.map((w) => w.name)).toEqual(["1. Xếp hạng và quà tặng", "2. Số lượng quà cần chuẩn bị"]);
    const sheet = workbook.worksheets[0]!;
    expect(sheet.getRow(4).values).toEqual(expect.arrayContaining(["Hạng", "Họ tên", "Tổng sao khóa", "Ký nhận"]));
    expect(sheet.getRow(5).values).toEqual(expect.arrayContaining([1, "A1", "Học viên A1", 6, 100, "Bộ lắp ráp", "Chờ duyệt"]));

    const pdf = await renderExport(doc, "pdf");
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(5000);
  });
});

describe("nhật ký và cấu hình", () => {
  it("chỉ Admin xem nhật ký; lọc theo hành động và phân trang", async () => {
    await expect(reports.listAuditLogs(f.actorA, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    const all = await reports.listAuditLogs(f.admin, {});
    expect(all.total).toBeGreaterThan(3);
    const starsOnly = await reports.listAuditLogs(f.admin, { action: "star_" });
    expect(starsOnly.rows.length).toBe(3);
    expect(starsOnly.rows.every((r) => r.action === "star_recorded" && r.username === "gv.a")).toBe(true);
    expect((await reports.listAuditLogs(f.admin, { action: "100%" })).total).toBe(0);
    expect((await reports.listAuditLogs(f.admin, { from: "2030-01-01" })).total).toBe(0);
    expect(await reports.listAuditTables(f.admin)).toEqual(expect.arrayContaining(["star_logs", "sessions"]));
  });

  it("Admin đổi cấu hình, có nhật ký; GV bị từ chối", async () => {
    await expect(reports.updateSettings(f.actorA, { attendance_lock_days: 1, max_deduction_per_session: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await reports.updateSettings(f.admin, { attendance_lock_days: 14, max_deduction_per_session: 5 });
    expect(await getSettings()).toEqual({ attendance_lock_days: 14, max_deduction_per_session: 5 });
    await reports.updateSettings(f.admin, { attendance_lock_days: 3, max_deduction_per_session: 5 });
    expect((await getSettings()).attendance_lock_days).toBe(3);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "settings_updated"));
    expect(logs).toHaveLength(2);
    expect(logs.some((l) => (l.oldValue as { attendance_lock_days: number }).attendance_lock_days === 14)).toBe(true);
  });

  it("học viên rời lớp trước khi đóng không nằm trong tổng kết", async () => {
    await db.update(enrollments).set({ status: "left", leftAt: "2026-01-14" }).where(eq(enrollments.studentId, a2()));
    await close();
    const rows = await db.select().from(courseSummaries).where(eq(courseSummaries.classId, f.classA.id));
    expect(rows.map((r) => r.studentId)).toEqual([a1()]);
  });
});
