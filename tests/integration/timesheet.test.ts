import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLogs, sessions, teacherRates, timeSlots, timesheetEntries, timesheetOverrides } from "@/db/schema";
import { DEFAULT_PERMISSIONS, type MenuPermission, type RolePermissions } from "@/lib/permissions";
import type { Actor } from "@/server/guard";
import * as rateSvc from "@/server/services/teacher-rates";
import * as svc from "@/server/services/timesheet";
import { teacherTimesheet, timesheetDoc } from "@/server/services/timesheet";
import { type Fixture, resetDb, seedFixture } from "./helpers";

let f: Fixture;
let morning: typeof timeSlots.$inferSelect;
let afternoon: typeof timeSlots.$inferSelect;
// Thứ Tư 21/01/2026 (giờ Việt Nam).
const now = new Date("2026-01-21T05:00:00Z");
const january = { from: "2026-01-01", to: "2026-01-31" };

const withTimesheet = (actor: Actor, scope: RolePermissions["scope"], timesheet: MenuPermission): Actor => ({
  ...actor,
  perms: { scope, menus: { ...DEFAULT_PERMISSIONS.teacher.menus, timesheet } },
});
const FULL: MenuPermission = { view: true, add: true, edit: true };
const VIEW: MenuPermission = { view: true, add: false, edit: false };

beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  [morning, afternoon] = (await db
    .insert(timeSlots)
    .values([
      { name: "Ca sáng", frame: 1, defaultStart: "08:00", defaultEnd: "09:30" },
      { name: "Ca chiều", frame: 1, defaultStart: "14:00", defaultEnd: "16:00" },
    ])
    .returning()) as [typeof timeSlots.$inferSelect, typeof timeSlots.$inferSelect];
  const a = { classId: f.classA.id, teacherId: f.teacherA.id, timeSlotId: morning.id, startTime: "08:00", endTime: "09:30" };
  await db.insert(sessions).values([
    { ...a, date: "2026-01-06", status: "done" },
    { ...a, date: "2026-01-13", status: "done", substituteTeacherId: f.teacherB.id }, // GV B dạy thay
    { ...a, date: "2026-01-20", status: "planned" }, // đã qua ngày, chưa điểm danh
    { ...a, date: "2026-01-27", status: "planned" }, // chưa tới ngày
    { ...a, date: "2026-01-08", status: "cancelled" },
    { ...a, date: "2026-02-03", status: "done" }, // ngoài tháng 1
    { classId: f.classB.id, teacherId: f.teacherB.id, date: "2026-01-07", startTime: "14:00", endTime: "15:00", status: "done" },
    { classId: f.classB.id, teacherId: null, date: "2026-01-09", startTime: "14:00", endTime: "15:00", status: "done" }, // chưa phân công
  ]);
});

const sessionOn = async (date: string) => (await db.select().from(sessions).where(and(eq(sessions.classId, f.classA.id), eq(sessions.date, date))))[0]!;
const entry = (over: Partial<Parameters<typeof svc.createTimesheetEntry>[1]> = {}) => ({
  teacherId: f.teacherA.id,
  date: "2026-01-10",
  timeSlotId: afternoon.id,
  classId: f.classB.id,
  role: "main" as const,
  note: null,
  ...over,
});

describe("chấm công giáo viên", () => {
  it("tính công cho người thực dạy theo khoảng ngày; bỏ buổi hủy; tách buổi chưa điểm danh và chưa tới ngày", async () => {
    const { rows, summary } = await teacherTimesheet(f.admin, january, now);
    expect(rows).toHaveLength(5);
    expect(summary).toEqual([
      { teacherId: f.teacherA.id, teacherCode: "GVA", teacherName: "Giáo viên A", taught: 1, substitute: 0, assistant: 0, minutes: 90, pending: 1, upcoming: 1, rates: [], amount: 0, missingRate: 1 },
      { teacherId: f.teacherB.id, teacherCode: "GVB", teacherName: "Giáo viên B", taught: 2, substitute: 1, assistant: 0, minutes: 150, pending: 0, upcoming: 0, rates: [], amount: 0, missingRate: 2 },
    ]);
    expect(rows.filter((r) => r.teacherId === f.teacherA.id).map((r) => [r.date, r.state, r.slotLabel])).toEqual([
      ["2026-01-06", "taught", "Sáng – Khung 1"],
      ["2026-01-20", "pending", "Sáng – Khung 1"],
      ["2026-01-27", "upcoming", "Sáng – Khung 1"],
    ]);
    // Dòng công xếp tăng dần theo ngày (không gom theo giáo viên); Tổng công vẫn theo mã giáo viên.
    expect(rows.map((r) => [r.date, r.teacherCode, r.className])).toEqual([
      ["2026-01-06", "GVA", "Lớp A"],
      ["2026-01-07", "GVB", "Lớp B"],
      ["2026-01-13", "GVB", "Lớp A"],
      ["2026-01-20", "GVA", "Lớp A"],
      ["2026-01-27", "GVA", "Lớp A"],
    ]);
    // Cùng ngày thì giờ dạy trước ở trên.
    await db.insert(sessions).values({ classId: f.classB.id, teacherId: f.teacherB.id, date: "2026-01-20", startTime: "07:00", endTime: "07:45", status: "done" });
    const sameDay = (await teacherTimesheet(f.admin, january, now)).rows.filter((r) => r.date === "2026-01-20");
    expect(sameDay.map((r) => [r.startTime.slice(0, 5), r.teacherCode])).toEqual([["07:00", "GVB"], ["08:00", "GVA"]]);
  });

  it("lọc theo giáo viên và theo lớp (tính theo khóa)", async () => {
    const onlyB = await teacherTimesheet(f.admin, { ...january, teacherId: f.teacherB.id }, now);
    expect(onlyB.summary.map((s) => s.teacherCode)).toEqual(["GVB"]);
    expect(onlyB.rows.map((r) => [r.classCode, r.isSubstitute])).toEqual([["B", false], ["A", true]]);

    const course = await teacherTimesheet(f.admin, { from: f.classA.startDate, to: f.classA.endDate, classId: f.classA.id }, now);
    expect(course.summary.map((s) => [s.teacherCode, s.taught])).toEqual([["GVA", 2], ["GVB", 1]]);
  });

  it("tính công trợ giảng riêng", async () => {
    await db.update(sessions).set({ assistantTeacherId: f.teacherB.id }).where(and(eq(sessions.classId, f.classA.id), eq(sessions.date, "2026-01-06")));

    const { rows, summary } = await teacherTimesheet(f.admin, january, now);
    expect(summary.find((s) => s.teacherId === f.teacherA.id)).toMatchObject({ taught: 1, assistant: 0 });
    // B: dạy chính lớp B, dạy thay lớp A ngày 13, trợ giảng ngày 06.
    expect(summary.find((s) => s.teacherId === f.teacherB.id)).toMatchObject({ taught: 2, substitute: 1, assistant: 1 });
    expect(rows.filter((r) => r.date === "2026-01-06").map((r) => [r.teacherCode, r.role, r.part])).toEqual([
      ["GVA", "main", "lead"],
      ["GVB", "assistant", "assistant"],
    ]);
    const onlyB = await teacherTimesheet(f.admin, { ...january, teacherId: f.teacherB.id }, now);
    expect(onlyB.rows.map((r) => r.role).sort()).toEqual(["assistant", "main", "substitute"]);
  });

  it("chỉ Admin xem được", async () => {
    await expect(teacherTimesheet(f.actorA, january, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("mức lương giáo viên/nhân viên và thành tiền", () => {
  const rate = (teacherId: string, classId: string, amount: number) => ({ teacherId, classId, rate: amount });

  it("thành tiền = số công đã dạy × mức lương của đúng Giáo viên + Lớp; công chưa có mức lương được đếm riêng", async () => {
    // GV A ở lớp A 300.000đ/buổi; GV B ở lớp A 150.000đ/buổi (B dạy thay và trợ giảng ở lớp A), B ở lớp B chưa đặt.
    await rateSvc.createTeacherRate(f.admin, rate(f.teacherA.id, f.classA.id, 300_000));
    await rateSvc.createTeacherRate(f.admin, rate(f.teacherB.id, f.classA.id, 150_000));
    await db.update(sessions).set({ assistantTeacherId: f.teacherB.id }).where(and(eq(sessions.classId, f.classA.id), eq(sessions.date, "2026-01-06")));

    let sheet = await teacherTimesheet(f.admin, january, now);
    // A: 1 công đã dạy (buổi 20/01 chưa điểm danh và 27/01 chưa tới ngày không tính tiền).
    expect(sheet.summary.find((s) => s.teacherId === f.teacherA.id)).toMatchObject({ taught: 1, rates: [300_000], amount: 300_000, missingRate: 0 });
    // B: dạy thay lớp A (150.000) + trợ giảng lớp A (150.000) + dạy chính lớp B (chưa có mức lương).
    expect(sheet.summary.find((s) => s.teacherId === f.teacherB.id)).toMatchObject({ taught: 2, assistant: 1, rates: [150_000], amount: 300_000, missingRate: 1 });
    expect(sheet.rows.filter((r) => r.teacherId === f.teacherA.id).map((r) => [r.date, r.rate, r.amount])).toEqual([
      ["2026-01-06", 300_000, 300_000],
      ["2026-01-20", 300_000, null],
      ["2026-01-27", 300_000, null],
    ]);

    // Công bổ sung của A ở lớp B (đặt 200.000) và dòng công sửa sang lớp B đều lấy mức lương của lớp B.
    const rateB = await rateSvc.createTeacherRate(f.admin, rate(f.teacherA.id, f.classB.id, 200_000));
    await svc.createTimesheetEntry(f.admin, entry());
    const session = await sessionOn("2026-01-06");
    await svc.adjustSessionTimesheet(f.admin, { sessionId: session.id, part: "lead", date: session.date, timeSlotId: session.timeSlotId, classId: f.classB.id, note: null });
    sheet = await teacherTimesheet(f.admin, january, now);
    expect(sheet.summary.find((s) => s.teacherId === f.teacherA.id)).toMatchObject({ taught: 2, rates: [200_000], amount: 400_000, missingRate: 0 });

    // Sửa mức lương thì thành tiền đổi theo; xóa mức lương thì công thành "chưa có mức lương".
    await rateSvc.updateTeacherRate(f.admin, rateB.id, rate(f.teacherA.id, f.classB.id, 250_000));
    expect((await teacherTimesheet(f.admin, january, now)).summary.find((s) => s.teacherId === f.teacherA.id)).toMatchObject({ amount: 500_000 });
    await rateSvc.deleteTeacherRate(f.admin, rateB.id);
    expect((await teacherTimesheet(f.admin, january, now)).summary.find((s) => s.teacherId === f.teacherA.id)).toMatchObject({ amount: 0, missingRate: 2, rates: [] });
  });

  it("đặt mức lương: cần quyền Sửa và phạm vi tất cả lớp; xóa chỉ Admin; một giáo viên một mức lương mỗi lớp", async () => {
    const input = rate(f.teacherA.id, f.classA.id, 300_000);
    await expect(rateSvc.createTeacherRate(f.actorA, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rateSvc.createTeacherRate(withTimesheet(f.actorA, "all", VIEW), input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Phạm vi "lớp của mình": không tự đặt lương cho mình, cũng không xem danh sách mức lương.
    const own = withTimesheet(f.actorA, "own", FULL);
    await expect(rateSvc.createTeacherRate(own, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rateSvc.listTeacherRates(own)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const editor = withTimesheet(f.actorB, "all", FULL);
    const created = await rateSvc.createTeacherRate(editor, input);
    const duplicate = { code: "VALIDATION", fieldErrors: { classId: "Giáo viên này đã có mức lương ở lớp đó." } };
    await expect(rateSvc.createTeacherRate(editor, { ...input, rate: 1 })).rejects.toMatchObject(duplicate);
    const other = await rateSvc.createTeacherRate(editor, rate(f.teacherA.id, f.classB.id, 100_000));
    await expect(rateSvc.updateTeacherRate(editor, other.id, input)).rejects.toMatchObject(duplicate);
    await rateSvc.updateTeacherRate(editor, created.id, { ...input, rate: 350_000 });
    await expect(rateSvc.updateTeacherRate(own, created.id, { ...input, rate: 9_000_000 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(rateSvc.deleteTeacherRate(editor, other.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect((await rateSvc.listTeacherRates(withTimesheet(f.actorB, "all", VIEW))).map((r) => [r.teacherCode, r.classCode, r.rate])).toEqual([
      ["GVA", "A", 350_000],
      ["GVA", "B", 100_000],
    ]);
    // Người chỉ thấy công của mình vẫn thấy tiền của chính mình trên bảng công.
    const mine = await teacherTimesheet(withTimesheet(f.actorA, "own", VIEW), january, now);
    expect(mine.summary).toMatchObject([{ teacherCode: "GVA", amount: 350_000 }]);
    await rateSvc.deleteTeacherRate(f.admin, other.id);
    expect(await db.select().from(teacherRates)).toHaveLength(1);
    const logged = await db.select().from(auditLogs).where(eq(auditLogs.tableName, "teacher_rates"));
    expect(logged.map((l) => l.action).sort()).toEqual(["create", "create", "delete", "update"]);
  });
});

describe("chấm công bổ sung", () => {
  it("dòng công ghi tay cộng vào tổng công theo vai trò, không tạo buổi học; sửa và xóa được", async () => {
    const before = (await db.select().from(sessions)).length;
    const main = await svc.createTimesheetEntry(f.admin, entry({ note: "Dạy bù ngoài lịch" }));
    await svc.createTimesheetEntry(f.admin, entry({ date: "2026-01-11", role: "assistant" }));
    expect((await db.select().from(sessions)).length).toBe(before);

    let sheet = await teacherTimesheet(f.admin, january, now);
    // GV A: 1 công từ buổi học + 1 công bổ sung (120 phút theo khung chiều) + 1 công trợ giảng bổ sung.
    expect(sheet.summary.find((s) => s.teacherId === f.teacherA.id)).toMatchObject({ taught: 2, assistant: 1, minutes: 90 + 120 + 120 });
    expect(sheet.rows.filter((r) => r.source === "manual").map((r) => [r.date, r.classCode, r.role, r.state, r.slotLabel, r.note])).toEqual([
      ["2026-01-10", "B", "main", "taught", "Chiều – Khung 1", "Dạy bù ngoài lịch"],
      ["2026-01-11", "B", "assistant", "taught", "Chiều – Khung 1", null],
    ]);
    // Lọc theo lớp và theo giáo viên áp dụng cả cho công bổ sung.
    expect((await teacherTimesheet(f.admin, { ...january, classId: f.classA.id }, now)).rows.some((r) => r.source === "manual")).toBe(false);
    expect((await teacherTimesheet(f.admin, { ...january, teacherId: f.teacherB.id }, now)).rows.some((r) => r.source === "manual")).toBe(false);

    // Sửa: đổi ngày, ca, lớp, giáo viên.
    await svc.updateTimesheetEntry(f.admin, main.id, entry({ teacherId: f.teacherB.id, date: "2026-01-12", timeSlotId: morning.id, classId: f.classA.id }));
    sheet = await teacherTimesheet(f.admin, january, now);
    expect(sheet.rows.filter((r) => r.id === main.id).map((r) => [r.teacherCode, r.date, r.classCode, r.slotLabel])).toEqual([
      ["GVB", "2026-01-12", "A", "Sáng – Khung 1"],
    ]);

    await svc.deleteTimesheetEntry(f.admin, main.id);
    expect((await db.select().from(timesheetEntries)).map((e) => e.date)).toEqual(["2026-01-11"]);
    const logged = await db.select().from(auditLogs).where(eq(auditLogs.tableName, "timesheet_entries"));
    expect(logged.map((l) => l.action).sort()).toEqual(["create", "create", "delete", "update"]);
  });

  it("không có hai dòng công của một giáo viên cùng Ngày + Ca + Khung giờ", async () => {
    const clash = { code: "VALIDATION", fieldErrors: { timeSlotId: "Giáo viên đã có công ở ngày, ca và khung giờ này." } };
    // GV A đã có buổi ngày 06/01 ca sáng.
    await expect(svc.createTimesheetEntry(f.admin, entry({ date: "2026-01-06", timeSlotId: morning.id }))).rejects.toMatchObject(clash);
    // Khác khung giờ hoặc khác giáo viên thì được.
    const first = await svc.createTimesheetEntry(f.admin, entry({ date: "2026-01-06" }));
    await svc.createTimesheetEntry(f.admin, entry({ date: "2026-01-06", teacherId: f.teacherB.id }));
    await expect(svc.createTimesheetEntry(f.admin, entry({ date: "2026-01-06" }))).rejects.toMatchObject(clash);
    // Sửa chính dòng đó thì không tự trùng với mình; sửa sang khung đã có công thì bị chặn.
    await svc.updateTimesheetEntry(f.admin, first.id, entry({ date: "2026-01-06", note: "ghi chú" }));
    await expect(svc.updateTimesheetEntry(f.admin, first.id, entry({ date: "2026-01-06", timeSlotId: morning.id }))).rejects.toMatchObject(clash);
  });

  it("theo quyền Thêm/Sửa của menu Chấm công; xóa chỉ Admin; phạm vi lớp của mình chỉ thao tác công của chính mình", async () => {
    const viewer = withTimesheet(f.actorA, "all", VIEW);
    await expect(svc.createTimesheetEntry(viewer, entry())).rejects.toMatchObject({ code: "FORBIDDEN" });
    const mine = await svc.createTimesheetEntry(f.admin, entry());
    const others = await svc.createTimesheetEntry(f.admin, entry({ teacherId: f.teacherB.id }));
    await expect(svc.updateTimesheetEntry(viewer, mine.id, entry())).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(svc.adjustSessionTimesheet(viewer, { sessionId: (await sessionOn("2026-01-06")).id, part: "lead", date: "2026-01-05", timeSlotId: null, classId: f.classA.id, note: null })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const own = withTimesheet(f.actorA, "own", FULL);
    await svc.createTimesheetEntry(own, entry({ date: "2026-01-15" }));
    await expect(svc.createTimesheetEntry(own, entry({ date: "2026-01-15", teacherId: f.teacherB.id }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await svc.updateTimesheetEntry(own, mine.id, entry({ note: "tự sửa" }));
    await expect(svc.updateTimesheetEntry(own, others.id, entry({ teacherId: f.teacherB.id, note: "x" }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(svc.updateTimesheetEntry(own, mine.id, entry({ teacherId: f.teacherB.id, date: "2026-01-16" }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Buổi 13/01 do GV B dạy thay: dòng công là của B, GV A không sửa được.
    const subbed = await sessionOn("2026-01-13");
    await expect(svc.adjustSessionTimesheet(own, { sessionId: subbed.id, part: "lead", date: "2026-01-14", timeSlotId: null, classId: f.classA.id, note: null })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(svc.deleteTimesheetEntry(own, mine.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const all = withTimesheet(f.actorA, "all", FULL);
    await svc.updateTimesheetEntry(all, others.id, entry({ teacherId: f.teacherB.id, note: "sửa hộ" }));
    await expect(svc.deleteTimesheetEntry(all, others.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("sửa chấm công của buổi học", () => {
  it("chỉ đổi Ngày / Ca / Lớp trên bảng công, buổi học giữ nguyên; lọc theo giá trị sau khi sửa; sửa về gốc thì bỏ dấu Đã sửa", async () => {
    const session = await sessionOn("2026-01-06");
    const adjust = (over: Partial<Parameters<typeof svc.adjustSessionTimesheet>[1]>) =>
      svc.adjustSessionTimesheet(f.admin, { sessionId: session.id, part: "lead", date: session.date, timeSlotId: session.timeSlotId, classId: session.classId, note: null, ...over });

    await adjust({ date: "2026-02-10", timeSlotId: afternoon.id, classId: f.classB.id, note: "Ghi nhầm ngày" });
    // Buổi học không đổi.
    expect(await sessionOn("2026-01-06")).toMatchObject({ date: "2026-01-06", classId: f.classA.id, timeSlotId: morning.id, startTime: "08:00:00" });

    // Tháng 1 không còn dòng này; tháng 2 có, theo lớp B, giờ của khung chiều, không còn phòng của buổi gốc.
    const jan = await teacherTimesheet(f.admin, january, now);
    expect(jan.rows.some((r) => r.id === session.id)).toBe(false);
    expect(jan.summary.find((s) => s.teacherId === f.teacherA.id)).toMatchObject({ taught: 0 });
    const feb = await teacherTimesheet(f.admin, { from: "2026-02-01", to: "2026-02-28" }, now);
    const moved = feb.rows.find((r) => r.id === session.id)!;
    expect(moved).toMatchObject({ date: "2026-02-10", classCode: "B", slotLabel: "Chiều – Khung 1", minutes: 120, edited: true, note: "Ghi nhầm ngày", state: "taught", roomName: null });
    expect((await teacherTimesheet(f.admin, { from: "2026-02-01", to: "2026-02-28", classId: f.classB.id }, now)).rows.map((r) => r.id)).toEqual([session.id]);
    expect((await teacherTimesheet(f.admin, { from: "2026-01-01", to: "2026-02-28", classId: f.classA.id }, now)).rows.some((r) => r.id === session.id)).toBe(false);

    // Sửa lần nữa: cập nhật đúng một phần sửa.
    await adjust({ date: "2026-01-05" });
    expect(await db.select().from(timesheetOverrides)).toHaveLength(1);
    expect((await teacherTimesheet(f.admin, january, now)).rows.find((r) => r.id === session.id)).toMatchObject({ date: "2026-01-05", classCode: "A", edited: true, minutes: 90 });

    // Trùng Ngày + Ca + Khung với buổi 20/01 của chính GV A thì bị chặn.
    await expect(adjust({ date: "2026-01-20" })).rejects.toMatchObject({ code: "VALIDATION" });

    // Sửa về đúng giá trị của buổi: bỏ phần sửa.
    await adjust({});
    expect(await db.select().from(timesheetOverrides)).toHaveLength(0);
    expect((await teacherTimesheet(f.admin, january, now)).rows.find((r) => r.id === session.id)).toMatchObject({ date: "2026-01-06", edited: false });
    const logged = await db.select().from(auditLogs).where(eq(auditLogs.tableName, "timesheet_overrides"));
    expect(logged.map((l) => l.action).sort()).toEqual(["create", "delete", "update"]);
  });

  it("buổi đã hủy hoặc vai không có người thì không sửa được", async () => {
    const cancelled = await sessionOn("2026-01-08");
    const input = { part: "lead" as const, date: "2026-01-09", timeSlotId: null, classId: f.classA.id, note: null };
    await expect(svc.adjustSessionTimesheet(f.admin, { ...input, sessionId: cancelled.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const session = await sessionOn("2026-01-06");
    await expect(svc.adjustSessionTimesheet(f.admin, { ...input, sessionId: session.id, part: "assistant" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("xuất chấm công", () => {
  it("tệp tổng hợp gồm mọi giáo viên kèm dòng tổng; tệp riêng chỉ có một giáo viên; có cột Mức lương, Thành tiền", async () => {
    await svc.createTimesheetEntry(f.admin, entry({ note: "Dạy bù" }));
    await rateSvc.createTeacherRate(f.admin, { teacherId: f.teacherA.id, classId: f.classA.id, rate: 300_000 });
    await rateSvc.createTeacherRate(f.admin, { teacherId: f.teacherA.id, classId: f.classB.id, rate: 200_000 });
    await rateSvc.createTeacherRate(f.admin, { teacherId: f.teacherB.id, classId: f.classB.id, rate: 250_000 });
    const all = await timesheetDoc(f.admin, january, now);
    expect(all.filename).toBe("cham-cong-tong-hop-2026-01-01-2026-01-31");
    const [summary, detail] = all.sections;
    expect(summary!.columns.map((c) => c.header)).toEqual([
      "STT", "Mã GV", "Giáo viên", "Số buổi", "Dạy thay", "Trợ giảng", "Số giờ", "Chưa điểm danh", "Mức lương (đ)", "Thành tiền (đ)", "Ghi chú",
    ]);
    // GV A: 2 công (lớp A 300.000 + bổ sung lớp B 200.000); GV B: lớp B 250.000 + dạy thay lớp A chưa có mức lương; dòng cuối là tổng cộng.
    expect(summary!.rows.map((r) => [r[1], r[3], r[4], r[8], r[9], r[10]])).toEqual([
      [f.teacherA.code, 2, 0, "200.000 / 300.000", 500_000, ""],
      [f.teacherB.code, 2, 1, 250_000, 250_000, "1 công chưa có mức lương"],
      ["", 4, 1, "", 750_000, ""],
    ]);
    // Chi tiết: không còn cột Ca, Phòng; cột Thứ không có chữ "Thứ"; cột Lớp là tên lớp; xếp theo ngày rồi giờ.
    expect(detail!.columns.map((c) => c.header)).toEqual([
      "STT", "Thứ", "Ngày", "Giờ", "Mã GV", "Giáo viên", "Vai trò", "Lớp", "Trạng thái", "Mức lương (đ)", "Thành tiền (đ)", "Ghi chú",
    ]);
    expect(detail!.rows.map((r) => [r[1], r[2], r[4], r[7]])).toEqual([
      ["Ba", "06/01/2026", "GVA", "Lớp A"],
      ["Tư", "07/01/2026", "GVB", "Lớp B"],
      ["Bảy", "10/01/2026", "GVA", "Lớp B"],
      ["Ba", "13/01/2026", "GVB", "Lớp A"],
      ["Ba", "20/01/2026", "GVA", "Lớp A"],
      ["Ba", "27/01/2026", "GVA", "Lớp A"],
    ]);
    expect(detail!.rows[0]!.slice(1, 4)).toEqual(["Ba", "06/01/2026", "08:00–09:30"]);
    expect(detail!.rows[0]!.slice(-3)).toEqual([300_000, 300_000, ""]);
    expect(detail!.rows[2]!.slice(-3)).toEqual([200_000, 200_000, "Bổ sung · Dạy bù"]);
    // Buổi chưa điểm danh: có mức lương nhưng chưa có thành tiền.
    expect(detail!.rows[4]!.slice(-3)).toEqual([300_000, "", ""]);
    expect(detail!.rows[3]!.slice(-3)).toEqual(["", "", "Chưa có mức lương"]);

    const own = await timesheetDoc(f.admin, { ...january, teacherId: f.teacherB.id }, now);
    expect(own.filename).toBe(`cham-cong-${f.teacherB.code}-2026-01-01-2026-01-31`);
    expect(own.sections[0]!.rows).toHaveLength(1);
    expect(new Set(own.sections[1]!.rows.map((r) => r[4]))).toEqual(new Set([f.teacherB.code]));
    // Vai trò Giáo viên mặc định không có menu Chấm công.
    await expect(timesheetDoc(f.actorA, january, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
