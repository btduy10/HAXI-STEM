import ExcelJS from "exceljs";
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLogs, classes, courses, sessions, syllabusLessons } from "@/db/schema";
import { DEFAULT_PERMISSIONS, type Menu, type MenuPermission } from "@/lib/permissions";
import type { Actor } from "@/server/guard";
import * as attendance from "@/server/services/attendance";
import * as classSvc from "@/server/services/classes";
import * as svc from "@/server/services/syllabus";
import { type Fixture, resetDb, seedFixture } from "./helpers";

// Lớp không gắn với khóa học: mỗi bài Syllabus thuộc Lớp + Khóa học + Buổi. Khóa "Robotics" có sẵn; "Robotics 2" thêm ở đây.
let f: Fixture;
let second: typeof courses.$inferSelect;
const NONE: MenuPermission = { view: false, add: false, edit: false, delete: false };
/** Giáo viên A với quyền menu Syllabus cho trước (phạm vi lớp của mình). */
const withSyllabus = (syllabus: MenuPermission, actor: Actor = f.actorA): Actor => ({
  ...actor,
  perms: { scope: "own", menus: { ...DEFAULT_PERMISSIONS.teacher!.menus, syllabus } as Record<Menu, MenuPermission> },
});
const lesson = (classId: string, period: number, title: string, product: string | null = null, courseId: string = f.course.id) => ({
  classId,
  courseId,
  period,
  title,
  product,
});
const edit = (period: number, title: string, product: string | null = null) => ({ period, title, product });
const COURSE = "Robotics";
const COURSE_2 = "Robotics 2";

async function workbook(rows: (string | number)[][], header = ["Khóa học", "Lớp học", "Buổi", "Tên bài/Chủ đề", "Sản phẩm"]) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Syllabus");
  sheet.addRow(header);
  for (const row of rows) sheet.addRow(row);
  const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
  return { name: "syllabus.xlsx", size: bytes.byteLength, bytes };
}

beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  [second] = (await db.insert(courses).values({ name: COURSE_2, totalSessions: 10 }).returning()) as [typeof courses.$inferSelect];
});

describe("syllabus", () => {
  it("mỗi Lớp + Khóa học + Buổi một bài: một lớp học nhiều khóa; danh sách theo khóa, lớp rồi Buổi 1 trước; lọc theo khóa và lớp", async () => {
    const two = await svc.createLesson(f.admin, lesson(f.classA.id, 2, "Lắp ráp khung xe", "Khung xe hai bánh"));
    await svc.createLesson(f.admin, lesson(f.classB.id, 1, "Bài của lớp B"));
    await svc.createLesson(f.admin, lesson(f.classA.id, 10, "Tổng kết"));
    await svc.createLesson(f.admin, lesson(f.classA.id, 1, "Làm quen với robot"));
    // Cùng lớp A, khóa Robotics 2 cũng có Buổi 1 và Buổi 2.
    await svc.createLesson(f.admin, lesson(f.classA.id, 1, "Cảm biến", "Xe dò đường", second.id));
    await svc.createLesson(f.admin, lesson(f.classA.id, 2, "Tránh vật cản", null, second.id));
    await expect(svc.createLesson(f.admin, lesson(f.classA.id, 2, "Trùng buổi"))).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { period: "Lớp này đã có bài ở Buổi đó của khóa học này." },
    });
    await expect(svc.createLesson(f.admin, lesson(f.classA.id, 3, "Khóa không có", null, "00000000-0000-4000-8000-000000000000"))).rejects.toMatchObject({ code: "NOT_FOUND" });

    const all = await svc.listSyllabus(f.admin);
    expect(all.map((l) => [l.courseName, l.className, l.period, l.title, l.product])).toEqual([
      [COURSE, "Lớp A", 1, "Làm quen với robot", null],
      [COURSE, "Lớp A", 2, "Lắp ráp khung xe", "Khung xe hai bánh"],
      [COURSE, "Lớp A", 10, "Tổng kết", null],
      [COURSE, "Lớp B", 1, "Bài của lớp B", null],
      [COURSE_2, "Lớp A", 1, "Cảm biến", "Xe dò đường"],
      [COURSE_2, "Lớp A", 2, "Tránh vật cản", null],
    ]);
    expect((await svc.listSyllabus(f.admin, { classId: f.classB.id })).map((l) => l.title)).toEqual(["Bài của lớp B"]);
    expect((await svc.listSyllabus(f.admin, { courseId: second.id })).map((l) => l.title)).toEqual(["Cảm biến", "Tránh vật cản"]);
    expect(await svc.listSyllabus(f.admin, { courseId: second.id, classId: f.classB.id })).toEqual([]);

    // Sửa buổi, tên bài, sản phẩm; lớp và khóa của bài giữ nguyên; đổi sang buổi đã có bài của cùng khóa thì bị chặn.
    const updated = await svc.updateLesson(f.admin, two.id, edit(3, "Lắp ráp khung xe (sửa)", "Khung xe ba bánh"));
    expect(updated).toMatchObject({ classId: f.classA.id, courseId: f.course.id, period: 3, title: "Lắp ráp khung xe (sửa)", product: "Khung xe ba bánh" });
    await expect(svc.updateLesson(f.admin, two.id, edit(1, "Đè buổi 1"))).rejects.toMatchObject({ code: "VALIDATION" });
    // Lớp chỉ hiển thị trên Thời khóa biểu không có Syllabus.
    await db.update(classes).set({ timetableOnly: true }).where(eq(classes.id, f.classB.id));
    await expect(svc.createLesson(f.admin, lesson(f.classB.id, 2, "X"))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("lớp mới tạo (không có khóa) soạn Syllabus được ngay với bất kỳ khóa nào", async () => {
    const created = await classSvc.createClass(
      f.admin,
      { name: "RB - T4", defaultRoomId: null, startDate: "2026-02-01", endDate: "2026-12-31", maxSize: 8, timetableOnly: false },
      new Date("2026-01-20T05:00:00Z"),
    );
    expect(created).toMatchObject({ code: "RB2601", name: "RB - T4", courseId: null });
    await svc.createLesson(f.admin, lesson(created.id, 1, "Bài mở đầu", null, second.id));
    expect((await svc.listSyllabus(f.admin, { classId: created.id })).map((l) => [l.courseName, l.className, l.period])).toEqual([[COURSE_2, "RB - T4", 1]]);
  });

  it("giáo viên mặc định tự soạn Syllabus lớp mình: xem, thêm, sửa, xóa; lớp khác coi như không tồn tại", async () => {
    const own = await svc.createLesson(f.actorA, lesson(f.classA.id, 1, "Bài của tôi", "Sản phẩm 1"));
    const other = await svc.createLesson(f.admin, lesson(f.classB.id, 1, "Bài của lớp B"));
    expect((await svc.listSyllabus(f.actorA)).map((l) => l.classCode)).toEqual(["A"]);
    expect(await svc.listSyllabus(f.actorA, { classId: f.classB.id })).toEqual([]);
    await svc.updateLesson(f.actorA, own.id, edit(1, "Bài của tôi (sửa)"));

    await expect(svc.createLesson(f.actorA, lesson(f.classB.id, 9, "Lớp khác"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(svc.updateLesson(f.actorA, other.id, edit(1, "Sửa bài lớp khác"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(svc.deleteLesson(f.actorA, other.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await db.select().from(syllabusLessons).where(eq(syllabusLessons.id, other.id))).toHaveLength(1);

    await svc.deleteLesson(f.actorA, own.id);
    expect(await db.select().from(syllabusLessons).where(eq(syllabusLessons.id, own.id))).toHaveLength(0);
    const [log] = await db.select().from(auditLogs).where(eq(auditLogs.recordId, own.id)).orderBy(asc(auditLogs.createdAt)).offset(2);
    expect(log).toMatchObject({ action: "delete", tableName: "syllabus_lessons", userId: f.actorA.userId });
    await expect(svc.deleteLesson(f.actorA, own.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("từng ô tick của menu Syllabus được kiểm tra ở máy chủ: Xem, Thêm, Sửa, Xóa riêng rẽ", async () => {
    const made = await svc.createLesson(f.admin, lesson(f.classA.id, 1, "Bài 1"));
    const denied = { code: "FORBIDDEN" };
    const none = withSyllabus(NONE);
    await expect(svc.listSyllabus(none)).rejects.toMatchObject(denied);
    await expect(svc.createLesson(none, lesson(f.classA.id, 2, "X"))).rejects.toMatchObject(denied);

    const viewer = withSyllabus({ view: true, add: false, edit: false, delete: false });
    expect(await svc.listSyllabus(viewer)).toHaveLength(1);
    await expect(svc.createLesson(viewer, lesson(f.classA.id, 2, "X"))).rejects.toMatchObject(denied);
    await expect(svc.updateLesson(viewer, made.id, edit(1, "X"))).rejects.toMatchObject(denied);
    await expect(svc.deleteLesson(viewer, made.id)).rejects.toMatchObject(denied);
    await expect(svc.buildSyllabusTemplate(viewer)).rejects.toMatchObject(denied);

    // Có Thêm và Sửa nhưng không tick Xóa (hoặc cấu hình cũ chưa có ô Xóa): không xóa được.
    for (const syllabus of [{ view: true, add: true, edit: true, delete: false }, { view: true, add: true, edit: true }]) {
      const editor = withSyllabus(syllabus);
      await svc.updateLesson(editor, made.id, edit(1, "Bài 1 (sửa)"));
      await expect(svc.deleteLesson(editor, made.id)).rejects.toMatchObject(denied);
    }
    // Chỉ tick Xóa (kèm Xem): xóa được, không thêm được.
    const remover = withSyllabus({ view: true, add: false, edit: false, delete: true });
    await expect(svc.createLesson(remover, lesson(f.classA.id, 2, "X"))).rejects.toMatchObject(denied);
    await svc.deleteLesson(remover, made.id);
    expect(await db.select().from(syllabusLessons)).toHaveLength(0);
  });

  it("nhập Excel: Khóa học theo tên ở menu Khóa học, Lớp học theo tên hoặc mã; xem trước báo lỗi từng dòng; thêm mới và cập nhật bài đã có", async () => {
    await svc.createLesson(f.admin, lesson(f.classA.id, 1, "Tên cũ", "Sản phẩm cũ"));
    const file = await workbook([
      [COURSE, "Lớp A", 1, "Tên mới của buổi 1", "Sản phẩm mới"],
      ["robotics", "a", 2, "Bài 2 (ghi mã lớp)", ""],
      [COURSE, "KHONG-CO", 1, "Lớp không tồn tại", ""],
      ["", "Lớp B", "ba", "", ""],
      [COURSE, "lớp a", 2, "Lặp trong tệp", ""],
      ["Khóa lạ", "Lớp B", 1, "Khóa không có", ""],
      [COURSE_2, "Lớp A", 1, "Buổi 1 của khóa Robotics 2", "Robot dò đường"],
    ]);

    const preview = await svc.previewSyllabusImport(f.admin, file);
    expect([preview.validCount, preview.errorCount]).toEqual([3, 4]);
    const byRow = Object.fromEntries(preview.rows.map((r) => [r.rowNumber, r.errors.join(" | ")]));
    expect(byRow[4]).toContain('Không có lớp "KHONG-CO"');
    expect(byRow[5]).toMatch(/Thiếu Khóa học/);
    expect(byRow[5]).toMatch(/Buổi phải là số nguyên/);
    expect(byRow[5]).toMatch(/Thiếu Tên bài\/Chủ đề/);
    expect(byRow[6]).toContain("Trùng Lớp học + Khóa học + Buổi");
    expect(byRow[7]).toBe('Không có khóa học "Khóa lạ" trong menu Khóa học');
    // Xem trước không ghi gì.
    expect(await db.select().from(syllabusLessons)).toHaveLength(1);

    const result = await svc.commitSyllabusImport(f.admin, file);
    expect([result.inserted, result.updated]).toEqual([2, 1]);
    const all = await svc.listSyllabus(f.admin);
    expect(all.map((l) => [l.courseName, l.classCode, l.period, l.title, l.product])).toEqual([
      [COURSE, "A", 1, "Tên mới của buổi 1", "Sản phẩm mới"],
      [COURSE, "A", 2, "Bài 2 (ghi mã lớp)", null],
      [COURSE_2, "A", 1, "Buổi 1 của khóa Robotics 2", "Robot dò đường"],
    ]);
    const [log] = await db.select().from(auditLogs).where(eq(auditLogs.action, "import"));
    expect(log).toMatchObject({ tableName: "syllabus_lessons", newValue: { inserted: 2, updated: 1 } });

    // Hai lớp trùng tên: ghi tên thì báo lỗi kèm các mã lớp, ghi mã thì nhập được.
    await db.update(classes).set({ name: "Lớp A" }).where(eq(classes.id, f.classB.id));
    const sameName = await svc.previewSyllabusImport(f.admin, await workbook([[COURSE, "Lớp A", 7, "Không rõ lớp nào", ""], [COURSE, "B", 7, "Ghi mã lớp B", ""]]));
    expect(sameName.rows.map((r) => r.errors.join(" | "))).toEqual(['Có 2 lớp tên "Lớp A"; hãy ghi mã lớp (A, B)', ""]);
    expect(sameName.rows[1]!.data).toMatchObject({ classId: f.classB.id });

    // Thiếu cột bắt buộc thì từ chối cả tệp; thiếu cột Sản phẩm vẫn nhập được; tệp mẫu đọc lại được.
    await expect(svc.previewSyllabusImport(f.admin, await workbook([[COURSE, "A", 1]], ["Khóa học", "Lớp học", "Buổi"]))).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(svc.previewSyllabusImport(f.admin, await workbook([["A", "ROB", 1, "Bài"]], ["Lớp", "Mã môn", "Tiết", "Tên bài"]))).rejects.toMatchObject({ code: "VALIDATION" });
    const noProduct = await svc.previewSyllabusImport(f.admin, await workbook([[COURSE, "A", 5, "Không có cột sản phẩm"]], ["Khóa học", "Lớp học", "Buổi", "Tên bài/Chủ đề"]));
    expect([noProduct.validCount, noProduct.rows[0]!.data]).toEqual([1, { classId: f.classA.id, courseId: f.course.id, period: 5, title: "Không có cột sản phẩm", product: null }]);
    const template = await svc.buildSyllabusTemplate(f.admin);
    const sample = await svc.previewSyllabusImport(f.admin, { name: "mau-syllabus.xlsx", size: template.byteLength, bytes: template });
    expect([sample.validCount, sample.errorCount]).toEqual([2, 0]);
  });

  it("giáo viên nhập Excel theo quyền Thêm, chỉ vào lớp của mình; cập nhật bài đã có cần quyền Sửa", async () => {
    await svc.createLesson(f.admin, lesson(f.classA.id, 1, "Tên cũ"));
    const file = await workbook([
      [COURSE, "Lớp A", 1, "Tên mới", "SP 1"],
      [COURSE, "Lớp A", 2, "Bài 2", "SP 2"],
      [COURSE, "Lớp B", 1, "Bài của lớp B", ""],
    ]);
    // Không có quyền Thêm: không xem trước, không ghi, không tải tệp mẫu.
    const viewer = withSyllabus({ view: true, add: false, edit: true, delete: true });
    await expect(svc.previewSyllabusImport(viewer, file)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(svc.commitSyllabusImport(viewer, file)).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Có Thêm nhưng không có Sửa: bài đã có bị báo lỗi, bài mới vẫn nhập được; lớp khác bị báo lỗi.
    const adder = withSyllabus({ view: true, add: true, edit: false, delete: false });
    const preview = await svc.previewSyllabusImport(adder, file);
    expect(preview.rows.map((r) => r.errors.join(" | "))).toEqual([
      "Lớp này đã có bài ở Buổi đó của khóa học này; cần quyền Sửa của Syllabus để cập nhật",
      "",
      'Không có lớp "Lớp B" trong các lớp bạn được ghi Syllabus',
    ]);
    expect(await svc.commitSyllabusImport(adder, file)).toMatchObject({ inserted: 1, updated: 0 });
    expect((await svc.listSyllabus(f.admin)).map((l) => [l.classCode, l.period, l.title])).toEqual([
      ["A", 1, "Tên cũ"],
      ["A", 2, "Bài 2"],
    ]);

    // Giáo viên mặc định (đủ Thêm, Sửa): cập nhật được bài của lớp mình; lớp B vẫn không ghi được.
    expect(await svc.commitSyllabusImport(f.actorA, file)).toMatchObject({ inserted: 0, updated: 2, errorCount: 1 });
    expect((await svc.listSyllabus(f.admin)).map((l) => [l.classCode, l.period, l.title, l.product])).toEqual([
      ["A", 1, "Tên mới", "SP 1"],
      ["A", 2, "Bài 2", "SP 2"],
    ]);
    // Tệp mẫu của giáo viên điền sẵn lớp của chính mình và một khóa có thật.
    const template = await svc.buildSyllabusTemplate(f.actorA);
    const sample = await svc.previewSyllabusImport(f.actorA, { name: "mau.xlsx", size: template.byteLength, bytes: template });
    expect(sample.rows.map((r) => [r.courseName, r.className])).toEqual([[COURSE, "Lớp A"], [COURSE, "Lớp A"]]);
  });

  it("điểm danh: bài của lớp theo khóa rồi theo buổi, kèm tên khóa; lưu nội dung là tên bài kèm nhận xét của giáo viên", async () => {
    await svc.createLesson(f.admin, lesson(f.classA.id, 2, "Lắp ráp khung xe"));
    await svc.createLesson(f.admin, lesson(f.classA.id, 1, "Cảm biến", null, second.id));
    await svc.createLesson(f.admin, lesson(f.classA.id, 1, "Làm quen với robot", "Robot chào hỏi"));
    await svc.createLesson(f.admin, lesson(f.classB.id, 1, "Bài của lớp B"));
    const [session] = await db
      .insert(sessions)
      .values({ classId: f.classA.id, date: "2026-01-13", startTime: "08:00", endTime: "09:30", teacherId: f.teacherA.id })
      .returning();
    const now = new Date("2026-01-13T05:00:00Z");

    // Giáo viên của lớp không có quyền menu Syllabus vẫn thấy bài của lớp mình để chọn.
    const sheet = await attendance.getAttendanceSheet(withSyllabus(NONE), session!.id, now);
    expect(sheet.lessons).toEqual([
      { courseName: COURSE, period: 1, title: "Làm quen với robot" },
      { courseName: COURSE, period: 2, title: "Lắp ráp khung xe" },
      { courseName: COURSE_2, period: 1, title: "Cảm biến" },
    ]);
    expect(sheet.teacherRemark).toBe("");

    const entries = sheet.rows.map((r) => ({ studentId: r.studentId, status: "present" as const, note: null }));
    const content = "Robotics · Buổi 1 – Làm quen với robot";
    await attendance.saveAttendance(f.actorA, { sessionId: session!.id, content, remark: "Lớp học tốt, cần thêm pin.", entries }, now);
    const [saved] = await db.select().from(sessions).where(eq(sessions.id, session!.id));
    expect(saved).toMatchObject({ status: "done", content, teacherRemark: "Lớp học tốt, cần thêm pin." });
    expect((await attendance.getAttendanceSheet(f.actorA, session!.id, now)).teacherRemark).toBe("Lớp học tốt, cần thêm pin.");

    // Không gửi nhận xét thì giữ nguyên; gửi rỗng thì xóa.
    await attendance.saveAttendance(f.actorA, { sessionId: session!.id, content: null, entries }, now);
    expect((await db.select().from(sessions).where(eq(sessions.id, session!.id)))[0]!.teacherRemark).toBe("Lớp học tốt, cần thêm pin.");
    await attendance.saveAttendance(f.actorA, { sessionId: session!.id, content: null, remark: null, entries }, now);
    expect((await db.select().from(sessions).where(eq(sessions.id, session!.id)))[0]!.teacherRemark).toBeNull();
  });
});
