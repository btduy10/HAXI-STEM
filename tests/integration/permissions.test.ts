import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLogs, sessions, students as studentsTable, teachers as teachersTable, user as userTable } from "@/db/schema";
import { DEFAULT_PERMISSIONS, type Menu, type MenuPermission, type RolePermissions, normalizePermissions } from "@/lib/permissions";
import { type Actor, can, seesStudentPrivate } from "@/server/guard";
import { getPermissionConfig } from "@/server/settings";
import * as accounts from "@/server/services/accounts";
import * as attendance from "@/server/services/attendance";
import * as catalog from "@/server/services/catalog";
import * as classes from "@/server/services/classes";
import * as reports from "@/server/services/reports";
import * as sessionSvc from "@/server/services/sessions";
import * as stars from "@/server/services/stars";
import * as students from "@/server/services/students";
import { teacherTimesheet } from "@/server/services/timesheet";
import { type Fixture, resetDb, seedFixture } from "./helpers";

let f: Fixture;
let sessionA: typeof sessions.$inferSelect;
let sessionB: typeof sessions.$inferSelect;
const now = new Date("2026-01-13T05:00:00Z"); // 13/01/2026, 12:00 giờ Việt Nam
const FULL: MenuPermission = { view: true, add: true, edit: true };
const VIEW: MenuPermission = { view: true, add: false, edit: false };

/** Người dùng với bảng quyền tùy chỉnh (như khi Admin tick trong Cấu hình). */
const withPerms = (actor: Actor, scope: RolePermissions["scope"], menus: Partial<Record<Menu, MenuPermission>>): Actor => ({
  ...actor,
  perms: { scope, menus: { ...DEFAULT_PERMISSIONS.teacher.menus, ...menus } },
});
const entries = (rows: { studentId: string }[], status: "present" | "absent" = "present") =>
  rows.map((r) => ({ studentId: r.studentId, status, note: null }));

beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  const base = { date: "2026-01-13", startTime: "08:00", endTime: "09:30" };
  [sessionA, sessionB] = (await db
    .insert(sessions)
    .values([
      { ...base, classId: f.classA.id, teacherId: f.teacherA.id },
      { ...base, classId: f.classB.id, teacherId: f.teacherB.id, startTime: "10:00", endTime: "11:30" },
    ])
    .returning()) as [typeof sessions.$inferSelect, typeof sessions.$inferSelect];
});

describe("bảng phân quyền", () => {
  it("chuẩn hóa: thiếu thì lấy mặc định, không có Xem thì bỏ Thêm/Sửa", () => {
    expect(normalizePermissions(null)).toEqual(DEFAULT_PERMISSIONS);
    const config = normalizePermissions({
      teacher: { scope: "all", menus: { students: { view: false, add: true, edit: true }, reports: FULL } },
      duty_teacher: { scope: "lạ" },
    });
    expect(config.teacher.scope).toBe("all");
    expect(config.teacher.menus.students).toEqual({ view: false, add: false, edit: false });
    expect(config.teacher.menus.reports).toEqual(FULL);
    expect(config.teacher.menus.attendance).toEqual(FULL); // không gửi → giữ mặc định
    expect(config.duty_teacher).toEqual(DEFAULT_PERMISSIONS.duty_teacher);
  });

  it("mặc định: Giáo viên xem học viên lớp mình, không có thông tin cá nhân; Giáo viên trực xem + sửa và có thông tin cá nhân", () => {
    expect(DEFAULT_PERMISSIONS.teacher).toMatchObject({ scope: "own", studentPrivate: false });
    expect(DEFAULT_PERMISSIONS.teacher!.menus.students).toEqual(VIEW);
    expect(DEFAULT_PERMISSIONS.duty_teacher).toMatchObject({ scope: "all", studentPrivate: true });
    expect(DEFAULT_PERMISSIONS.duty_teacher!.menus.students).toEqual({ view: true, add: false, edit: true });
  });

  it("ô tick Thông tin cá nhân học viên: cấu hình cũ chưa có thì theo mặc định của vai trò; vai trò tự tạo mặc định không có", () => {
    // Cấu hình lưu trước khi có ô tick: không có trường studentPrivate.
    const old = normalizePermissions({
      teacher: { scope: "own", menus: {} },
      duty_teacher: { scope: "all", menus: {} },
      role_le_tan: { label: "Lễ tân", scope: "all", menus: { students: FULL } },
    });
    expect([old.teacher!.studentPrivate, old.duty_teacher!.studentPrivate, old.role_le_tan!.studentPrivate]).toEqual([false, true, false]);
    // Admin đã tick/bỏ tick thì giữ đúng lựa chọn; giá trị sai kiểu bị bỏ qua.
    const chosen = normalizePermissions({
      teacher: { studentPrivate: true },
      duty_teacher: { studentPrivate: false },
      role_le_tan: { label: "Lễ tân", studentPrivate: "true" },
    });
    expect([chosen.teacher!.studentPrivate, chosen.duty_teacher!.studentPrivate, chosen.role_le_tan!.studentPrivate]).toEqual([true, false, false]);
    // Menu QL Học viên không còn Thêm: ô Thêm lưu từ trước bị bỏ.
    expect(old.role_le_tan!.menus.students).toEqual({ view: true, add: false, edit: true });
    expect(seesStudentPrivate(f.admin)).toBe(true);
    expect(seesStudentPrivate(f.actorA)).toBe(false);
    expect(seesStudentPrivate({ ...f.actorA, perms: old.duty_teacher })).toBe(true);
    expect(seesStudentPrivate({ ...f.actorA, role: "role_da_xoa" })).toBe(false);
  });

  it("chỉ Admin lưu được; lưu xong có hiệu lực và có nhật ký", async () => {
    const next = normalizePermissions({ ...DEFAULT_PERMISSIONS, duty_teacher: { scope: "own", menus: { students: VIEW } } });
    await expect(reports.updatePermissions(f.actorA, next)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(reports.readPermissions(f.actorA)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await getPermissionConfig()).toEqual(DEFAULT_PERMISSIONS);

    await reports.updatePermissions(f.admin, next);
    const saved = await getPermissionConfig();
    expect(saved.duty_teacher.scope).toBe("own");
    expect(saved.duty_teacher.menus.students).toEqual(VIEW);
    const [log] = await db.select().from(auditLogs).where(eq(auditLogs.action, "permissions_updated"));
    expect(log).toMatchObject({ userId: f.admin.userId, tableName: "app_settings" });
  });

  it("Admin tạo vai trò mới, gán cho tài khoản; không xóa được vai trò đang dùng; tên không trùng", async () => {
    const custom = { label: "Trợ giảng", scope: "own" as const, menus: { ...DEFAULT_PERMISSIONS.teacher.menus, students: VIEW } };
    await reports.updatePermissions(f.admin, { ...DEFAULT_PERMISSIONS, role_tro_giang: custom });
    expect((await getPermissionConfig()).role_tro_giang).toMatchObject({ label: "Trợ giảng", scope: "own" });

    // Gán vai trò mới ở Tài khoản: cả tài khoản gắn giáo viên (GV B) lẫn tài khoản không gắn giáo viên.
    const accountB = { id: f.actorB.userId, username: "gv.b", name: "Giáo viên B", teacherId: f.teacherB.id };
    await accounts.updateAccount(f.admin, { ...accountB, role: "role_tro_giang" });
    const [b] = await db.select().from(userTable).where(eq(userTable.id, f.actorB.userId));
    expect(b!.role).toBe("role_tro_giang");
    const { id } = await accounts.createAccount(f.admin, { username: "tro.giang", name: "Trợ giảng", role: "role_tro_giang", teacherId: null, password: "MatKhauTam123" });
    expect((await db.select().from(userTable).where(eq(userTable.id, id)))[0]!.role).toBe("role_tro_giang");
    await expect(
      accounts.createAccount(f.admin, { username: "la.lung", name: "x", role: "role_khong_co", teacherId: null, password: "MatKhauTam123" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(accounts.updateAccount(f.admin, { ...accountB, role: "role_khong_co" })).rejects.toMatchObject({ code: "VALIDATION" });

    // Đang có người mang vai trò: không xóa được. Tên trùng (kể cả trùng "Quản trị"): bị từ chối.
    await expect(reports.updatePermissions(f.admin, DEFAULT_PERMISSIONS)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(reports.updatePermissions(f.admin, { ...DEFAULT_PERMISSIONS, role_tro_giang: { ...custom, label: "giáo viên" } })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(reports.updatePermissions(f.admin, { ...DEFAULT_PERMISSIONS, role_tro_giang: { ...custom, label: "Quản trị" } })).rejects.toMatchObject({ code: "VALIDATION" });

    // Gỡ vai trò khỏi mọi tài khoản rồi mới xóa được (còn một tài khoản mang vai trò thì vẫn bị chặn).
    await accounts.deleteAccount(f.admin, id);
    await expect(reports.updatePermissions(f.admin, DEFAULT_PERMISSIONS)).rejects.toMatchObject({ code: "CONFLICT" });
    await accounts.updateAccount(f.admin, { ...accountB, role: "teacher" });
    await reports.updatePermissions(f.admin, DEFAULT_PERMISSIONS);
    expect(Object.keys(await getPermissionConfig())).toEqual(["teacher", "duty_teacher"]);
  });

  it("vai trò tự tạo dùng đúng quyền được tick; vai trò đã xóa hoặc lạ không có quyền gì", async () => {
    const helper: Actor = { ...f.actorA, role: "role_tro_giang", perms: { scope: "own", menus: { ...DEFAULT_PERMISSIONS.teacher.menus, students: VIEW, attendance: VIEW } } };
    expect(can(helper, "students", "view")).toBe(true);
    expect(can(helper, "attendance", "add")).toBe(false);
    const unknown: Actor = { userId: f.actorA.userId, role: "role_da_xoa", teacherId: f.teacherA.id };
    expect(can(unknown, "attendance", "view")).toBe(false);
    await expect(attendance.getAttendanceSheet(unknown, sessionA.id, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(can({ ...unknown, role: "constructor" }, "attendance", "view")).toBe(false);
  });

  it("chuẩn hóa vai trò tự tạo: khóa hoặc tên không hợp lệ bị bỏ, hai vai trò có sẵn giữ tên cố định", () => {
    const config = normalizePermissions({
      teacher: { label: "Đổi tên", scope: "own" },
      role_ok: { label: "  Lễ tân  ", scope: "all", menus: { students: FULL } },
      "Khóa Sai": { label: "x" },
      role_khong_ten: { scope: "own" },
      admin: { label: "Giả quản trị", scope: "all" },
    });
    expect(Object.keys(config)).toEqual(["teacher", "duty_teacher", "role_ok"]);
    expect(config.teacher!.label).toBe("Giáo viên");
    expect(config.role_ok).toMatchObject({ label: "Lễ tân", scope: "all" });
    expect(config.role_ok!.menus.students).toEqual({ view: true, add: false, edit: true });
    expect(config.role_ok!.menus.attendance).toEqual({ view: false, add: false, edit: false });
  });

  it("Admin luôn có toàn quyền; vai trò lạ không có quyền gì", () => {
    expect(can(f.admin, "rewards", "edit")).toBe(true);
    expect(can(f.actorA, "attendance", "add")).toBe(true);
    // Giáo viên mặc định xem được QL Học viên nhưng không sửa; không có menu Ghi danh.
    expect(can(f.actorA, "students", "view")).toBe(true);
    expect(can(f.actorA, "students", "edit")).toBe(false);
    expect(can(f.actorA, "enrollments", "view")).toBe(false);
    expect(can({ ...f.actorA, role: "khác" }, "attendance", "view")).toBe(false);
  });
});

describe("vai trò chỉ gán ở Tài khoản", () => {
  const teacherB = { code: "GVB", fullName: "Giáo viên B", shortName: null, phone: null, email: null, status: "active" as const };
  const roleOf = async (userId: string) => (await db.select({ role: userTable.role }).from(userTable).where(eq(userTable.id, userId)))[0]!.role;

  it("tài khoản gắn giáo viên giữ đúng vai trò Admin chọn khi tạo và khi sửa; sửa hồ sơ giáo viên không đổi vai trò", async () => {
    await accounts.updateAccount(f.admin, { id: f.actorB.userId, username: "gv.b", name: "Giáo viên B", role: "duty_teacher", teacherId: f.teacherB.id });
    expect(await roleOf(f.actorB.userId)).toBe("duty_teacher");
    expect(await roleOf(f.actorA.userId)).toBe("teacher");
    expect(await roleOf(f.admin.userId)).toBe("admin");

    await catalog.updateTeacher(f.admin, f.teacherB.id, { ...teacherB, fullName: "Tên mới" });
    expect(await roleOf(f.actorB.userId)).toBe("duty_teacher");
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "account_role_synced"))).toHaveLength(0);

    // Tạo lại tài khoản cho giáo viên B: nhận đúng vai trò được chọn.
    await accounts.deleteAccount(f.admin, f.actorB.userId);
    const { id } = await accounts.createAccount(f.admin, { username: "gv.b2", name: "B", role: "duty_teacher", teacherId: f.teacherB.id, password: "MatKhauTam123" });
    expect(await roleOf(id)).toBe("duty_teacher");
  });

  it("người được tick Sửa Giáo viên sửa hồ sơ giáo viên nhưng không đụng được tới vai trò của tài khoản (không tự nâng quyền)", async () => {
    const editor = withPerms(f.actorB, "own", { teachers: FULL });
    await catalog.updateTeacher(editor, f.teacherB.id, { ...teacherB, fullName: "Tên mới" });
    const [stored] = await db.select().from(teachersTable).where(eq(teachersTable.id, f.teacherB.id));
    expect(stored).toMatchObject({ fullName: "Tên mới" });
    expect(stored).not.toHaveProperty("role");
    expect(await roleOf(f.actorB.userId)).toBe("teacher");
    await expect(
      accounts.updateAccount(editor, { id: f.actorB.userId, username: "gv.b", name: "Giáo viên B", role: "duty_teacher", teacherId: f.teacherB.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await roleOf(f.actorB.userId)).toBe("teacher");
  });
});

describe("Giáo viên trực (mặc định: thấy mọi lớp, hỗ trợ điểm danh)", () => {
  const duty = (): Actor => ({ userId: f.actorB.userId, role: "duty_teacher", teacherId: null });

  it("thấy mọi lớp và mọi buổi, điểm danh được lớp bất kỳ", async () => {
    expect((await classes.listClasses(duty())).map((c) => c.code).sort()).toEqual(["A", "B"]);
    expect(await sessionSvc.listSessions(duty(), { from: "2026-01-13", to: "2026-01-13", personal: true })).toHaveLength(2);
    const sheet = await attendance.getAttendanceSheet(duty(), sessionA.id, now);
    expect(sheet.canSave).toBe(true);
    await expect(attendance.saveAttendance(duty(), { sessionId: sessionA.id, content: null, entries: entries(sheet.rows) }, now)).resolves.toMatchObject({ changed: 2 });
    expect(await attendance.listOverdueSessions(duty(), new Date("2026-01-14T05:00:00Z"))).toHaveLength(1); // buổi lớp B chưa điểm danh
  });

  it("không chấm sao, không sửa lịch, không mở khóa, không xóa; xem được danh sách học viên", async () => {
    const [criteria] = await catalogCriteria();
    const denied = { code: "FORBIDDEN" };
    await expect(stars.awardStars(duty(), { sessionId: sessionA.id, criteriaId: criteria!, studentIds: [f.students[0]!.id], note: null }, now)).rejects.toMatchObject(denied);
    await expect(sessionSvc.cancelSession(duty(), { id: sessionA.id, note: null })).rejects.toMatchObject(denied);
    expect((await students.listStudentsPage(duty(), undefined, 1)).total).toBe(6);
    await expect(classes.deleteStudent(duty(), f.students[0]!.id)).rejects.toMatchObject(denied);
    await expect(attendance.unlockAttendance(duty(), sessionA.id, now)).rejects.toMatchObject(denied);
    await expect(sessionSvc.deleteSession(duty(), sessionA.id)).rejects.toMatchObject(denied);
    await expect(reports.updatePermissions(duty(), DEFAULT_PERMISSIONS)).rejects.toMatchObject(denied);
  });
});

async function catalogCriteria() {
  const { starCriteria } = await import("@/db/schema");
  const rows = await db.insert(starCriteria).values({ name: "+1", stars: 1, type: "reward" }).returning();
  return rows.map((r) => r.id);
}

describe("quyền theo menu", () => {
  it("điểm danh: Thêm cho buổi chưa điểm danh, Sửa cho buổi đã lưu, chỉ Xem thì không lưu được", async () => {
    const addOnly = withPerms(f.actorA, "own", { attendance: { view: true, add: true, edit: false } });
    const viewOnly = withPerms(f.actorA, "own", { attendance: VIEW });
    const none = withPerms(f.actorA, "own", { attendance: { view: false, add: false, edit: false } });
    const sheet = await attendance.getAttendanceSheet(viewOnly, sessionA.id, now);
    expect(sheet.canSave).toBe(false);
    const input = { sessionId: sessionA.id, content: null, entries: entries(sheet.rows) };
    await expect(attendance.getAttendanceSheet(none, sessionA.id, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(attendance.saveAttendance(viewOnly, input, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(attendance.saveAttendance(addOnly, input, now)).resolves.toBeDefined();
    await expect(attendance.saveAttendance(addOnly, { ...input, entries: entries(sheet.rows, "absent") }, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(attendance.saveAttendance(f.actorA, { ...input, entries: entries(sheet.rows, "absent") }, now)).resolves.toMatchObject({ changed: 2 });
  });

  it("học viên: chỉ thấy học viên lớp mình, không có thông tin cá nhân; sửa không ghi được thông tin đó", async () => {
    await db.update(studentsTable).set({ guardianName: "Phụ huynh", note: "ghi chú", birthDate: "2015-01-01", gender: "male" });
    const viewer = withPerms(f.actorA, "own", { students: FULL });
    const page = await students.listStudentsPage(viewer, undefined, 1);
    expect(page.rows.map((s) => s.code).sort()).toEqual(["A1", "A2"]);
    expect(page.rows.every((s) => s.phone === null && s.guardianName === null && s.note === null && s.birthDate === null && s.gender === null)).toBe(true);
    expect((await students.listStudentsPage(withPerms(f.actorA, "all", { students: VIEW }), undefined, 1)).total).toBe(6);
    expect((await students.listStudentsPage(f.admin, "A1", 1)).rows[0]).toMatchObject({ phone: "0900000000", guardianName: "Phụ huynh" });

    const input = { code: "A1", fullName: "Tên mới", birthDate: null, gender: null, schoolGrade: 5, guardianName: "Chèn", phone: "0999999999", status: "active" as const, note: "chèn" };
    const updated = await students.updateStudent(viewer, f.students[0]!.id, input);
    expect(updated).toMatchObject({ fullName: "Tên mới", phone: null });
    const [stored] = await db.select().from(studentsTable).where(eq(studentsTable.id, f.students[0]!.id));
    expect(stored).toMatchObject({ fullName: "Tên mới", schoolGrade: 5, phone: "0900000000", guardianName: "Phụ huynh", note: "ghi chú", birthDate: "2015-01-01" });
    // Học viên lớp khác: không sửa được, kể cả khi gửi đúng id.
    await expect(students.updateStudent(viewer, f.students[2]!.id, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Xóa luôn chỉ Admin dù được tick hết.
    await expect(classes.deleteStudent(viewer, f.students[4]!.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("Giáo viên mặc định: xem học viên lớp mình để theo dõi, không có thông tin cá nhân, không sửa được", async () => {
    const teacher: Actor = { ...f.actorA, perms: DEFAULT_PERMISSIONS.teacher };
    const page = await students.listStudentsPage(teacher, undefined, 1);
    expect(page.rows.map((s) => `${s.code}:${s.phone}`)).toEqual(["A1:null", "A2:null"]);
    expect(await students.getStudent(teacher, f.students[0]!.id)).toMatchObject({ code: "A1", phone: null });
    await expect(students.getStudent(teacher, f.students[2]!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const input = { code: "A1", fullName: "Sửa lậu", birthDate: null, gender: null, schoolGrade: 5, guardianName: null, phone: null, status: "active" as const, note: null };
    await expect(students.updateStudent(teacher, f.students[0]!.id, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("Giáo viên trực mặc định: thấy mọi học viên kèm thông tin cá nhân và sửa được khi sai", async () => {
    const duty: Actor = { ...f.actorB, role: "duty_teacher", perms: DEFAULT_PERMISSIONS.duty_teacher };
    const page = await students.listStudentsPage(duty, undefined, 1);
    expect(page.total).toBe(6);
    expect(page.rows[0]).toMatchObject({ code: "A1", phone: "0900000000" });

    const input = { code: "A1", fullName: "Học viên A1", birthDate: "2015-06-01", gender: "female" as const, schoolGrade: 4, guardianName: "Mẹ A1", phone: "0911222333", status: "active" as const, note: "đã sửa" };
    expect(await students.updateStudent(duty, f.students[0]!.id, input)).toMatchObject({ phone: "0911222333", guardianName: "Mẹ A1" });
    const [stored] = await db.select().from(studentsTable).where(eq(studentsTable.id, f.students[0]!.id));
    expect(stored).toMatchObject({ birthDate: "2015-06-01", gender: "female", guardianName: "Mẹ A1", phone: "0911222333", note: "đã sửa" });
    // Vẫn không xóa được, và bỏ tick Sửa thì chỉ còn xem.
    await expect(classes.deleteStudent(duty, f.students[0]!.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const viewOnly: Actor = { ...duty, perms: { ...DEFAULT_PERMISSIONS.duty_teacher!, menus: { ...DEFAULT_PERMISSIONS.duty_teacher!.menus, students: VIEW } } };
    await expect(students.updateStudent(viewOnly, f.students[0]!.id, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Tick thông tin cá nhân nhưng phạm vi lớp của mình: chỉ sửa được học viên lớp mình.
    const ownScope: Actor = { ...f.actorB, perms: { ...DEFAULT_PERMISSIONS.duty_teacher!, scope: "own" } };
    await expect(students.updateStudent(ownScope, f.students[0]!.id, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("thời khóa biểu và ghi danh: được tick thì làm được trong phạm vi lớp mình, lớp khác coi như không tồn tại", async () => {
    const scheduler = withPerms(f.actorA, "own", { timetable: FULL, enrollments: FULL });
    await expect(sessionSvc.updateSession(scheduler, { id: sessionA.id, startTime: "08:30", endTime: "09:30", roomId: null, teacherId: f.teacherA.id, assistantTeacherId: null, content: null, note: null })).resolves.toBeDefined();
    await expect(sessionSvc.cancelSession(scheduler, { id: sessionB.id, note: null })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(sessionSvc.deleteSession(scheduler, sessionA.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect((await students.listStudents(scheduler)).every((s) => s.phone === null)).toBe(true);
    await expect(classes.enrollStudent(scheduler, { classId: f.classA.id, studentId: f.students[4]!.id, joinedAt: "2026-01-10" })).resolves.toBeDefined();
    await expect(classes.enrollStudent(scheduler, { classId: f.classB.id, studentId: f.students[5]!.id, joinedAt: "2026-01-10" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(classes.listEnrollments(scheduler, f.classB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Cùng quyền nhưng phạm vi "Tất cả lớp" thì sửa được lớp B.
    await expect(sessionSvc.cancelSession(withPerms(f.actorA, "all", { timetable: FULL }), { id: sessionB.id, note: null })).resolves.toBeDefined();
  });

  it("danh mục: tick Thêm/Sửa mới ghi được; xóa chỉ Admin", async () => {
    const editor = withPerms(f.actorA, "own", { rooms: FULL });
    const room = await catalog.createRoom(editor, { name: "Lab mới", capacity: 5 });
    await expect(catalog.updateRoom(editor, room.id, { name: "Lab mới", capacity: 9 })).resolves.toMatchObject({ capacity: 9 });
    await expect(catalog.deleteRoom(editor, room.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(catalog.createCourse(editor, { name: "Khóa lậu", description: null, totalSessions: 3 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("chấm công: phạm vi lớp của mình chỉ thấy công của chính mình", async () => {
    await db.update(sessions).set({ status: "done" });
    const range = { from: "2026-01-01", to: "2026-01-31" };
    await expect(teacherTimesheet(f.actorA, range, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const own = await teacherTimesheet(withPerms(f.actorA, "own", { timesheet: VIEW }), { ...range, teacherId: f.teacherB.id }, now);
    expect(own.summary.map((s) => s.teacherCode)).toEqual(["GVA"]);
    const all = await teacherTimesheet(withPerms(f.actorA, "all", { timesheet: VIEW }), range, now);
    expect(all.summary.map((s) => s.teacherCode)).toEqual(["GVA", "GVB"]);
  });
});
