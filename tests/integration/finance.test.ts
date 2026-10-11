import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLogs, classes, enrollments, purchases, sessions, teacherRates, timeSlots, tuitionReceipts } from "@/db/schema";
import { DEFAULT_PERMISSIONS, type MenuPermission, type RolePermissions } from "@/lib/permissions";
import type { Actor } from "@/server/guard";
import * as finance from "@/server/services/finance";
import * as timesheet from "@/server/services/timesheet";
import { type Fixture, resetDb, seedFixture } from "./helpers";

let f: Fixture;
// Thứ Tư 21/01/2026 (giờ Việt Nam).
const now = new Date("2026-01-21T05:00:00Z");
const anchor = "2026-01-21";

const withReports = (actor: Actor, scope: RolePermissions["scope"], reports: MenuPermission): Actor => ({
  ...actor,
  perms: { scope, menus: { ...DEFAULT_PERMISSIONS.teacher.menus, reports } },
});
const FULL: MenuPermission = { view: true, add: true, edit: true };
const VIEW: MenuPermission = { view: true, add: false, edit: false };
const purchase = (purchasedAt: string, item: string, category: string, quantity: number, unitPrice: number) => ({ purchasedAt, item, category, quantity, unitPrice });

beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  // Học phí: lớp A 2.000.000đ, lớp B chưa đặt. Lớp A thêm một học viên đã rời lớp, chưa đóng gì.
  await db.update(classes).set({ tuitionFee: 2_000_000 }).where(eq(classes.id, f.classA.id));
  await db.insert(enrollments).values({ classId: f.classA.id, studentId: f.students[4]!.id, joinedAt: "2026-01-05", status: "left", leftAt: "2026-01-15" });
  const enrollmentOf = async (studentId: string) =>
    (await db.select().from(enrollments).where(and(eq(enrollments.classId, f.classA.id), eq(enrollments.studentId, studentId))))[0]!.id;
  const [a1, a2] = [await enrollmentOf(f.students[0]!.id), await enrollmentOf(f.students[1]!.id)];
  await db.insert(tuitionReceipts).values([
    { enrollmentId: a1, amount: 1_500_000, method: "cash", paidAt: "2026-01-05" },
    { enrollmentId: a1, amount: 500_000, method: "transfer", paidAt: "2026-02-10" },
    { enrollmentId: a2, amount: 400_000, method: "cash", paidAt: "2026-01-20" },
    { enrollmentId: a2, amount: 300_000, method: "cash", paidAt: "2026-01-21", status: "cancelled" }, // phiếu hủy không tính
  ]);

  // Chấm công: GV A dạy lớp A (300.000đ/buổi), GV B dạy lớp B chưa đặt mức lương.
  const a = { classId: f.classA.id, teacherId: f.teacherA.id, startTime: "08:00", endTime: "09:30" };
  await db.insert(sessions).values([
    { ...a, date: "2026-01-06", status: "done" },
    { ...a, date: "2026-01-13", status: "done" },
    { ...a, date: "2026-01-27", status: "planned" }, // chưa dạy: không tính lương
    { ...a, date: "2026-02-03", status: "done" },
    { classId: f.classB.id, teacherId: f.teacherB.id, date: "2026-01-07", startTime: "14:00", endTime: "15:00", status: "done" },
  ]);
  await db.insert(teacherRates).values({ teacherId: f.teacherA.id, classId: f.classA.id, rate: 300_000 });

  await finance.createPurchase(f.admin, purchase("2026-01-10", "Bộ robot", "Thiết bị", 2, 500_000));
  await finance.createPurchase(f.admin, purchase("2026-02-01", "Giấy A4", "Văn phòng phẩm", 10, 60_000));
});

describe("báo cáo doanh thu – chi – lãi", () => {
  it("theo tháng: doanh thu theo ngày thu (bỏ phiếu hủy), chi = lương từ Chấm công + mua sắm, lãi có thể âm", async () => {
    const report = await finance.financeReport(f.admin, { view: "month", anchor }, now);
    expect(report).toMatchObject({ from: "2026-01-01", to: "2026-12-31", missingRate: 1 });
    expect(report.rows).toHaveLength(12);
    expect(report.rows[0]).toMatchObject({ key: "2026-01", label: "T1", title: "Tháng 1/2026", revenue: 1_900_000, salary: 600_000, purchases: 1_000_000, expense: 1_600_000, profit: 300_000 });
    expect(report.rows[1]).toMatchObject({ key: "2026-02", revenue: 500_000, salary: 300_000, purchases: 600_000, expense: 900_000, profit: -400_000 });
    expect(report.rows[2]).toMatchObject({ revenue: 0, expense: 0, profit: 0 });
    expect(report.total).toEqual({ revenue: 2_400_000, salary: 900_000, purchases: 1_600_000, expense: 2_500_000, profit: -100_000 });

    // Chi lương khớp Thành tiền của Chấm công trong cùng khoảng ngày.
    const sheet = await timesheet.teacherTimesheet(f.admin, { from: report.from, to: report.to }, now);
    expect(sheet.summary.reduce((sum, s) => sum + s.amount, 0)).toBe(report.total.salary);
  });

  it("theo tuần (12 tuần tới tuần chứa ngày mốc) và theo năm (5 năm)", async () => {
    const weekly = await finance.financeReport(f.admin, { view: "week", anchor }, now);
    expect(weekly.rows).toHaveLength(12);
    expect(weekly.rows.at(-1)).toMatchObject({ key: "2026-01-19", from: "2026-01-19", to: "2026-01-25", label: "19/1", revenue: 400_000, salary: 0, purchases: 0, profit: 400_000 });
    expect(weekly.rows.find((r) => r.key === "2026-01-05")).toMatchObject({ revenue: 1_500_000, salary: 300_000, purchases: 1_000_000, profit: 200_000 });
    expect(weekly.rows[0]!.from).toBe("2025-11-03");
    // Số liệu tháng 2 nằm ngoài 12 tuần này.
    expect(weekly.total).toMatchObject({ revenue: 1_900_000, salary: 600_000, purchases: 1_000_000 });

    const yearly = await finance.financeReport(f.admin, { view: "year", anchor }, now);
    expect(yearly.rows.map((r) => r.key)).toEqual(["2022", "2023", "2024", "2025", "2026"]);
    expect(yearly.rows.at(-1)).toMatchObject({ revenue: 2_400_000, expense: 2_500_000, profit: -100_000 });
    expect(yearly.rows[0]).toMatchObject({ revenue: 0, expense: 0 });
  });

  it("chi lương theo tháng, từng giáo viên; công bổ sung cũng được tính", async () => {
    const january = await finance.salaryByTeacher(f.admin, "2026-01", now);
    expect(january).toMatchObject({ from: "2026-01-01", to: "2026-01-31" });
    expect(january.rows.map((s) => [s.teacherCode, s.taught, s.amount, s.missingRate])).toEqual([
      ["GVA", 2, 600_000, 0],
      ["GVB", 1, 0, 1],
    ]);
    expect(january.total).toEqual({ taught: 3, assistant: 0, amount: 600_000, missingRate: 1 });
    expect((await finance.salaryByTeacher(f.admin, "2026-03", now)).rows).toEqual([]);

    const [slot] = await db.insert(timeSlots).values({ name: "Ca chiều", frame: 1, defaultStart: "14:00", defaultEnd: "16:00" }).returning();
    await timesheet.createTimesheetEntry(f.admin, { teacherId: f.teacherA.id, date: "2026-01-15", timeSlotId: slot!.id, classId: f.classA.id, role: "main", note: null });
    expect((await finance.salaryByTeacher(f.admin, "2026-01", now)).total.amount).toBe(900_000);
    expect((await finance.financeReport(f.admin, { view: "month", anchor }, now)).rows[0]!.salary).toBe(900_000);
  });
});

describe("mua sắm", () => {
  it("thành tiền = số lượng × đơn giá; lọc theo khoảng ngày; gợi ý loại đã nhập", async () => {
    const january = await finance.listPurchases(f.admin, { from: "2026-01-01", to: "2026-01-31" });
    expect(january.rows.map((p) => [p.item, p.category, p.quantity, p.unitPrice, p.amount])).toEqual([["Bộ robot", "Thiết bị", 2, 500_000, 1_000_000]]);
    expect(january.total).toBe(1_000_000);
    expect((await finance.listPurchases(f.admin, { from: "2026-01-01", to: "2026-12-31" })).total).toBe(1_600_000);
    expect(await finance.purchaseCategories(f.admin)).toEqual(["Thiết bị", "Văn phòng phẩm"]);
  });

  it("theo quyền Thêm/Sửa của menu Báo cáo, xóa chỉ Admin; có nhật ký", async () => {
    const input = purchase("2026-01-12", "Pin sạc", "Thiết bị", 4, 50_000);
    const viewer = withReports(f.actorA, "all", VIEW);
    await expect(finance.createPurchase(viewer, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const adder = withReports(f.actorA, "all", { view: true, add: true, edit: false });
    const created = await finance.createPurchase(adder, input);
    expect(created).toMatchObject({ item: "Pin sạc", createdBy: f.actorA.userId });
    await expect(finance.updatePurchase(adder, created.id, { ...input, quantity: 5 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const editor = withReports(f.actorA, "all", FULL);
    await finance.updatePurchase(editor, created.id, { ...input, quantity: 5 });
    expect((await finance.listPurchases(viewer, { from: "2026-01-12", to: "2026-01-12" })).total).toBe(250_000);
    await expect(finance.deletePurchase(editor, created.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await finance.deletePurchase(f.admin, created.id);
    expect(await db.select().from(purchases)).toHaveLength(2);
    const logged = await db.select().from(auditLogs).where(eq(auditLogs.tableName, "purchases"));
    expect(logged.map((l) => l.action).sort()).toEqual(["create", "create", "create", "delete", "update"]);
  });
});

describe("học phí chưa đóng", () => {
  it("chỉ gồm học viên còn phải đóng ở lớp đã đặt học phí; tệp xuất không có dữ liệu cá nhân của học viên", async () => {
    const { rows, total } = await finance.unpaidTuition(f.admin);
    expect(rows.map((r) => [r.studentCode, r.classCode, r.due, r.paid, r.remaining, r.status, r.enrollmentStatus])).toEqual([
      ["A2", "A", 2_000_000, 400_000, 1_600_000, "partial", "active"],
      ["X1", "A", 2_000_000, 0, 2_000_000, "unpaid", "left"],
    ]);
    expect(total).toEqual({ due: 4_000_000, paid: 400_000, remaining: 3_600_000 });
    expect((await finance.unpaidTuition(f.admin, { classId: f.classB.id })).rows).toEqual([]);

    const doc = await finance.unpaidTuitionDoc(f.admin);
    expect(doc.filename).toBe("hoc-phi-chua-dong");
    const [section] = doc.sections;
    expect(section!.columns.map((c) => c.header)).toEqual([
      "STT", "Mã HV", "Họ tên", "Lớp", "Phải đóng (đ)", "Đã đóng (đ)", "Còn lại (đ)", "Trạng thái", "Ghi chú",
    ]);
    expect(section!.rows).toEqual([
      [1, "A2", "Học viên A2", "A", 2_000_000, 400_000, 1_600_000, "Đóng một phần", ""],
      [2, "X1", "Học viên X1", "A", 2_000_000, 0, 2_000_000, "Chưa đóng", "Đã rời lớp"],
      ["", "", "Tổng cộng", "", 4_000_000, 400_000, 3_600_000, "", ""],
    ]);
    // Số điện thoại trong hồ sơ học viên (0900000000) không xuất hiện ở bất kỳ ô nào.
    expect(JSON.stringify(doc)).not.toContain("0900000000");
    const byClass = await finance.unpaidTuitionDoc(f.admin, { classId: f.classA.id });
    expect(byClass.filename).toBe("hoc-phi-chua-dong-A");
    expect((await finance.unpaidTuitionDoc(f.admin, { classId: f.classB.id })).sections[0]!.rows).toEqual([]);
  });
});

describe("quyền xem báo cáo tài chính", () => {
  it("cần quyền ở menu Báo cáo VÀ phạm vi tất cả lớp; mặc định chỉ Admin", async () => {
    const denied = { code: "FORBIDDEN" };
    const calls = (actor: Actor) => [
      () => finance.financeReport(actor, { view: "month", anchor }, now),
      () => finance.salaryByTeacher(actor, "2026-01", now),
      () => finance.listPurchases(actor, { from: "2026-01-01", to: "2026-01-31" }),
      () => finance.purchaseCategories(actor),
      () => finance.unpaidTuition(actor),
      () => finance.unpaidTuitionDoc(actor),
    ];
    // Vai trò Giáo viên mặc định không có menu Báo cáo.
    for (const call of calls(f.actorA)) await expect(call()).rejects.toMatchObject(denied);
    // Có đủ Xem/Thêm/Sửa nhưng chỉ thấy lớp của mình: vẫn bị từ chối, kể cả nhập mua sắm.
    const own = withReports(f.actorA, "own", FULL);
    for (const call of calls(own)) await expect(call()).rejects.toMatchObject(denied);
    await expect(finance.createPurchase(own, purchase("2026-01-12", "x", "y", 1, 1))).rejects.toMatchObject(denied);
    // Phạm vi tất cả lớp + Xem: xem được mọi báo cáo, không cần quyền Học phí hay Chấm công.
    const viewer = withReports(f.actorA, "all", VIEW);
    for (const call of calls(viewer)) await expect(call()).resolves.toBeDefined();
  });
});
