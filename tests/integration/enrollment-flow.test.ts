import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attendances, auditLogs, classes, enrollments, makeupAssignments, sessions, starCriteria, starLogs, students, tuitionReceipts } from "@/db/schema";
import { DEFAULT_PERMISSIONS, type RolePermissions } from "@/lib/permissions";
import { newEnrollmentInput } from "@/lib/validation/entities";
import type { Actor } from "@/server/guard";
import * as attendanceSvc from "@/server/services/attendance";
import * as classSvc from "@/server/services/classes";
import * as makeupSvc from "@/server/services/makeups";
import * as starSvc from "@/server/services/stars";
import * as historySvc from "@/server/services/student-history";
import * as studentSvc from "@/server/services/students";
import { type Fixture, resetDb, seedFixture } from "./helpers";

// Hôm nay là Thứ Ba 13/01/2026. Lớp A đã dạy buổi 06/01 (A1 vắng, A2 có mặt), còn buổi 20/01.
// Lớp B có buổi 15/01 và 22/01 chưa dạy, và buổi 10/01 đã qua ngày mà chưa điểm danh.
const NOW = new Date("2026-01-13T05:00:00Z");
const TODAY = "2026-01-13";
let f: Fixture;
let absent: typeof sessions.$inferSelect;
let ownNext: typeof sessions.$inferSelect;
let target: typeof sessions.$inferSelect;
let later: typeof sessions.$inferSelect;
let past: typeof sessions.$inferSelect;
let plusThree: string;

type Grants = Partial<Record<"students" | "enrollments", { view: boolean; add: boolean; edit: boolean }>>;
const withMenus = (actor: Actor, menus: Grants, scope: RolePermissions["scope"] = "all"): Actor => ({
  ...actor,
  perms: { scope, menus: { ...DEFAULT_PERMISSIONS.teacher.menus, ...menus } },
});
const ALL = { view: true, add: true, edit: true };
const a1 = () => f.students[0]!.id;
const a2 = () => f.students[1]!.id;
const newStudent = (values: Record<string, unknown>) => newEnrollmentInput.parse({ fullName: "Học viên mới", schoolGrade: "", ...values });
const studentCount = async () => (await db.select().from(students)).length;
const needs = (actor: Actor = f.admin) => makeupSvc.listMakeupNeeds(actor, TODAY);
const assign = (makeupSessionId: string, actor: Actor = f.admin, studentId = a1()) =>
  makeupSvc.assignMakeup(actor, { absentSessionId: absent.id, studentId, makeupSessionId }, NOW);
/** Điểm danh buổi học bù của lớp B vào đúng ngày học (15/01). */
const recordTarget = (statusOfGuest: "present" | "absent", actor: Actor = f.actorB) =>
  attendanceSvc.saveAttendance(
    actor,
    {
      sessionId: target.id,
      content: "Bài 5: Cảm biến",
      entries: [
        { studentId: f.students[2]!.id, status: "present", note: null },
        { studentId: f.students[3]!.id, status: "present", note: null },
        { studentId: a1(), status: statusOfGuest, note: null },
      ],
    },
    new Date("2026-01-15T05:00:00Z"),
  );

beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  const [criteria] = await db.insert(starCriteria).values({ name: "+3", stars: 3, type: "reward" }).returning();
  plusThree = criteria!.id;
  const session = (classId: string, date: string, teacherId: string, extra: Partial<typeof sessions.$inferInsert> = {}) => ({
    classId,
    date,
    startTime: "18:00",
    endTime: "19:30",
    teacherId,
    ...extra,
  });
  [absent, ownNext, target, later, past] = (await db
    .insert(sessions)
    .values([
      session(f.classA.id, "2026-01-06", f.teacherA.id, { status: "done", content: "Bài 3: Động cơ" }),
      session(f.classA.id, "2026-01-20", f.teacherA.id),
      session(f.classB.id, "2026-01-15", f.teacherB.id),
      session(f.classB.id, "2026-01-22", f.teacherB.id),
      session(f.classB.id, "2026-01-10", f.teacherB.id),
    ])
    .returning()) as (typeof sessions.$inferSelect)[] as [
    typeof sessions.$inferSelect,
    typeof sessions.$inferSelect,
    typeof sessions.$inferSelect,
    typeof sessions.$inferSelect,
    typeof sessions.$inferSelect,
  ];
  await db.insert(attendances).values([
    { sessionId: absent.id, studentId: a1(), status: "excused" },
    { sessionId: absent.id, studentId: a2(), status: "present" },
  ]);
});

describe("mã học viên tự cấp", () => {
  it("mã luôn do máy chủ cấp: mã kế tiếp của năm, mã gửi kèm từ form bị bỏ qua", async () => {
    const create = (values: Record<string, unknown>) => classSvc.enrollNewStudent(f.admin, newStudent({ classId: "none", ...values }), NOW);
    expect((await create({ fullName: "Em Một" })).code).toBe("HX2601");
    expect((await create({ code: "", fullName: "Em Hai" })).code).toBe("HX2602");
    // Gửi kèm mã (kể cả mã đang có) vẫn nhận mã kế tiếp, không trùng.
    expect((await create({ code: "HX2610", fullName: "Em Ba" })).code).toBe("HX2603");
    expect((await create({ code: "HX2601", fullName: "Em Bốn" })).code).toBe("HX2604");
    // Mã sửa tay ở QL Học viên vẫn được tính khi cấp mã kế tiếp; sang năm sau đếm lại từ đầu.
    await db.update(students).set({ code: "HX2610" }).where(eq(students.code, "HX2604"));
    expect(await studentSvc.suggestStudentCode(db, NOW)).toBe("HX2611");
    expect(await studentSvc.suggestStudentCode(db, new Date("2027-01-02T05:00:00Z"))).toBe("HX2701");
  });

  it("hai người thêm cùng lúc không nhận trùng mã tự cấp", async () => {
    const codes = await Promise.all(
      ["Một", "Hai", "Ba"].map((name) => classSvc.enrollNewStudent(f.admin, newStudent({ classId: "none", fullName: name }), NOW).then((s) => s.code)),
    );
    expect(codes.sort()).toEqual(["HX2601", "HX2602", "HX2603"]);
  });
});

describe("ghi danh học viên mới", () => {
  it("tạo học viên và ghi danh trong một giao dịch; lớp hết chỗ thì không tạo dở học viên", async () => {
    const before = await studentCount();
    const made = await classSvc.enrollNewStudent(f.admin, newStudent({ classId: f.classA.id, joinedAt: TODAY, phone: "0901234567" }), NOW);
    expect(made).toMatchObject({ code: "HX2601" });
    expect(made.enrollmentId).toBeTruthy();
    const [row] = await db.select().from(students).where(eq(students.id, made.studentId));
    expect(row).toMatchObject({ fullName: "Học viên mới", phone: "0901234567", status: "active" });
    const [enrollment] = await db.select().from(enrollments).where(eq(enrollments.studentId, made.studentId));
    expect(enrollment).toMatchObject({ classId: f.classA.id, joinedAt: TODAY, status: "active" });

    // Lớp A tối đa 3 em và đã đủ: em thứ tư không được tạo.
    await expect(classSvc.enrollNewStudent(f.admin, newStudent({ classId: f.classA.id, joinedAt: TODAY }), NOW)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await studentCount()).toBe(before + 1);
    // Lớp đã đóng cũng không tạo dở.
    await db.update(classes).set({ status: "closed" }).where(eq(classes.id, f.classB.id));
    await expect(classSvc.enrollNewStudent(f.admin, newStudent({ classId: f.classB.id, joinedAt: TODAY }), NOW)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await studentCount()).toBe(before + 1);
  });

  it("chỉ cần quyền Thêm của menu Ghi danh; không được tick thông tin cá nhân thì không ghi được các ô đó", async () => {
    const input = () => newStudent({ classId: f.classB.id, joinedAt: TODAY, phone: "0901234567", guardianName: "Phụ huynh", note: "ghi chú" });
    await expect(classSvc.enrollNewStudent(f.actorA, input(), NOW)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Quyền ở menu QL Học viên không đủ để nhập học viên, kể cả khi không chọn lớp.
    await expect(classSvc.enrollNewStudent(withMenus(f.actorA, { students: ALL }), input(), NOW)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(classSvc.enrollNewStudent(withMenus(f.actorA, { students: ALL }), newStudent({ classId: "none" }), NOW)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      classSvc.enrollNewStudent(withMenus(f.actorA, { enrollments: { view: true, add: false, edit: true } }), input(), NOW),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Phạm vi "lớp của mình": không ghi danh được vào lớp của người khác, và không tạo dở học viên.
    const before = await studentCount();
    await expect(classSvc.enrollNewStudent(withMenus(f.actorA, { enrollments: ALL }, "own"), input(), NOW)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await studentCount()).toBe(before);

    const clerk = withMenus(f.actorA, { enrollments: ALL });
    const made = await classSvc.enrollNewStudent(clerk, input(), NOW);
    const [row] = await db.select().from(students).where(eq(students.id, made.studentId));
    expect(row).toMatchObject({ fullName: "Học viên mới", phone: null, guardianName: null, note: null });

    // Được tick "Thông tin cá nhân học viên" thì các ô đó được lưu.
    const trusted: Actor = { ...clerk, perms: { ...clerk.perms!, studentPrivate: true } };
    const second = await classSvc.enrollNewStudent(trusted, newStudent({ classId: "none", phone: "0901234567", guardianName: "Phụ huynh" }), NOW);
    const [kept] = await db.select().from(students).where(eq(students.id, second.studentId));
    expect(kept).toMatchObject({ phone: "0901234567", guardianName: "Phụ huynh" });
  });
});

describe("xóa học viên theo thứ tự: rời lớp trước rồi mới xóa", () => {
  const enrollmentOf = async (studentId: string) => (await db.select().from(enrollments).where(eq(enrollments.studentId, studentId)))[0]!;
  const exists = async (studentId: string) => (await db.select().from(students).where(eq(students.id, studentId))).length === 1;

  it("còn đang học thì bị chặn, thông báo nêu tên lớp; rời lớp rồi xóa được cùng ghi danh cũ, điểm danh, sao, lượt xếp bù", async () => {
    await starSvc.awardStars(f.admin, { sessionId: absent.id, criteriaId: plusThree, studentIds: [a1()], note: null }, NOW);
    await assign(target.id);
    await expect(classSvc.deleteStudent(f.admin, a1())).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Học viên đang học lớp A. Hãy cho rời lớp hoặc xóa khỏi lớp ở Ghi danh trước khi xóa học viên.",
    });
    expect(await exists(a1())).toBe(true);

    await classSvc.leaveEnrollment(f.admin, { id: (await enrollmentOf(a1())).id, leftAt: TODAY });
    expect(await classSvc.deleteStudent(f.admin, a1())).toEqual({ deletedEnrollments: 1, deletedAttendances: 1, deletedStarLogs: 1 });
    expect(await exists(a1())).toBe(false);
    expect(await db.select().from(enrollments).where(eq(enrollments.studentId, a1()))).toHaveLength(0);
    expect(await db.select().from(attendances).where(eq(attendances.studentId, a1()))).toHaveLength(0);
    expect(await db.select().from(starLogs).where(eq(starLogs.studentId, a1()))).toHaveLength(0);
    expect(await db.select().from(makeupAssignments).where(eq(makeupAssignments.studentId, a1()))).toHaveLength(0);
    // Dữ liệu của em khác không bị đụng tới; có ghi nhật ký.
    expect(await db.select().from(attendances).where(eq(attendances.studentId, a2()))).toHaveLength(1);
    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.tableName, "students"), eq(auditLogs.action, "delete")));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ recordId: a1(), newValue: { deletedEnrollments: 1, deletedAttendances: 1, deletedStarLogs: 1 } });
    await expect(classSvc.deleteStudent(f.admin, a1())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("xóa khỏi lớp (ghi danh nhập sai) cũng tính là đã rời lớp; em chưa thuộc lớp nào thì xóa được ngay", async () => {
    await classSvc.deleteEnrollment(f.admin, (await enrollmentOf(a2())).id);
    expect(await classSvc.deleteStudent(f.admin, a2())).toEqual({ deletedEnrollments: 0, deletedAttendances: 0, deletedStarLogs: 0 });
    expect(await classSvc.deleteStudent(f.admin, f.students[4]!.id)).toMatchObject({ deletedEnrollments: 0 });
    expect(await exists(f.students[4]!.id)).toBe(false);
  });

  it("đã có phiếu thu học phí hoặc có dữ liệu ở lớp đã đóng thì không xóa được, kể cả khi đã rời lớp", async () => {
    const paid = await enrollmentOf(a1());
    await db.insert(tuitionReceipts).values({ enrollmentId: paid.id, amount: 500_000, method: "cash", paidAt: TODAY });
    await classSvc.leaveEnrollment(f.admin, { id: paid.id, leftAt: TODAY });
    await expect(classSvc.deleteStudent(f.admin, a1())).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Học viên đã có phiếu thu học phí nên không xóa được. Hãy đổi trạng thái thành “Đã nghỉ”.",
    });

    const b1 = f.students[2]!.id;
    await classSvc.leaveEnrollment(f.admin, { id: (await enrollmentOf(b1)).id, leftAt: TODAY });
    await db.update(classes).set({ status: "closed" }).where(eq(classes.id, f.classB.id));
    await expect(classSvc.deleteStudent(f.admin, b1)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("lớp đã đóng") });
    expect(await exists(a1())).toBe(true);
    expect(await exists(b1)).toBe(true);
    expect(await db.select().from(attendances).where(eq(attendances.studentId, a1()))).toHaveLength(1);
  });

  it("chỉ Admin xóa được, dù vai trò được tick hết các quyền", async () => {
    const clerk = withMenus(f.actorA, { students: ALL, enrollments: ALL });
    await expect(classSvc.deleteStudent(clerk, f.students[4]!.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await exists(f.students[4]!.id)).toBe(true);
  });
});

describe("danh sách chờ lớp", () => {
  const waitingCodes = async (actor: Actor = f.admin) => (await studentSvc.listWaitingStudents(actor)).map((s) => s.code);

  it("học viên đang học chưa thuộc lớp đang mở nào; xếp lớp xong thì rời danh sách", async () => {
    expect(await waitingCodes()).toEqual(["X1", "X2"]);
    const made = await classSvc.enrollNewStudent(f.admin, newStudent({ classId: "none" }), NOW);
    expect(made.enrollmentId).toBeNull();
    expect(await waitingCodes()).toEqual(["X1", "X2", "HX2601"]);

    await classSvc.enrollStudent(f.admin, { classId: f.classA.id, studentId: made.studentId, joinedAt: TODAY });
    expect(await waitingCodes()).toEqual(["X1", "X2"]);
    // Học viên tạm nghỉ hoặc nghỉ hẳn không nằm trong danh sách chờ.
    await db.update(students).set({ status: "paused" }).where(eq(students.code, "X1"));
    await db.update(students).set({ status: "left" }).where(eq(students.code, "X2"));
    expect(await waitingCodes()).toEqual([]);
  });

  it("em rời lớp hoặc lớp đã đóng thì quay lại danh sách chờ; phạm vi lớp của mình không có danh sách này", async () => {
    const [enrollment] = await db.select().from(enrollments).where(eq(enrollments.studentId, a2()));
    await classSvc.leaveEnrollment(f.admin, { id: enrollment!.id, leftAt: TODAY });
    await db.update(classes).set({ status: "closed" }).where(eq(classes.id, f.classB.id));
    expect(await waitingCodes()).toEqual(["A2", "B1", "B2", "X1", "X2"]);

    await expect(waitingCodes(f.actorA)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await waitingCodes(withMenus(f.actorA, { enrollments: ALL }, "own"))).toEqual([]);
    // Ngoài Admin chỉ nhận mã, tên, khối, ngày tạo.
    const [row] = await studentSvc.listWaitingStudents(withMenus(f.actorA, { enrollments: ALL }));
    expect(Object.keys(row!).sort()).toEqual(["code", "createdAt", "fullName", "id", "schoolGrade"]);
  });
});

describe("học bù bằng cách học ghép vào buổi có sẵn", () => {
  it("buổi vắng của học viên đang học nằm trong danh sách cần học bù; buổi có thể bù là buổi chưa dạy sắp tới", async () => {
    const list = await needs();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ studentCode: "A1", classCode: "A", date: "2026-01-06", status: "excused", lesson: "Bài 3: Động cơ", state: "pending" });

    const targets = await makeupSvc.listMakeupTargets(f.admin, TODAY);
    // Không gồm buổi đã qua ngày (10/01) và buổi đã dạy (06/01).
    expect(targets.map((t) => `${t.classCode}|${t.date}`)).toEqual(["B|2026-01-15", "A|2026-01-20", "B|2026-01-22"]);
    expect(targets[0]).toMatchObject({ teacherName: "Giáo viên B", headcount: 2, maxSize: 3 });
    expect(await makeupSvc.activeClassIdsOf([a1()])).toEqual({ [a1()]: [f.classA.id] });

    // Em đã rời lớp thì buổi vắng không còn cần bù.
    const [enrollment] = await db.select().from(enrollments).where(eq(enrollments.studentId, a1()));
    await classSvc.leaveEnrollment(f.admin, { id: enrollment!.id, leftAt: TODAY });
    expect(await needs()).toEqual([]);
  });

  it("xếp bù: em có tên trong bảng điểm danh và ghi sao của buổi đó với nhãn học bù; giáo viên của buổi thao tác được", async () => {
    const row = await assign(target.id);
    expect(row).toMatchObject({ absentSessionId: absent.id, makeupSessionId: target.id, studentId: a1() });
    expect((await needs())[0]).toMatchObject({ state: "scheduled", makeupDate: "2026-01-15", makeupClassCode: "B" });
    // Sĩ số buổi học bù tính cả em học ghép.
    expect((await makeupSvc.listMakeupTargets(f.admin, TODAY))[0]!.headcount).toBe(3);

    const sheet = await attendanceSvc.getAttendanceSheet(f.actorB, target.id, new Date("2026-01-15T05:00:00Z"));
    expect(sheet.rows.map((r) => `${r.code}${r.makeup ? "*" : ""}`)).toEqual(["B1", "B2", "A1*"]);
    // Buổi của lớp A không đổi: em học bù không thuộc sĩ số lớp B ở các buổi khác.
    expect((await attendanceSvc.sessionRoster(db, later)).map((r) => r.code)).toEqual(["B1", "B2"]);

    await recordTarget("present");
    expect(await needs()).toEqual([]);
    const awarded = await starSvc.awardStars(f.actorB, { sessionId: target.id, criteriaId: plusThree, studentIds: [a1()], note: null }, new Date("2026-01-15T06:00:00Z"));
    expect(awarded).toMatchObject({ count: 1, stars: 3 });
    const board = await starSvc.getSessionStarBoard(f.actorB, target.id);
    expect(board.students.find((s) => s.code === "A1")).toMatchObject({ makeup: true, sessionStars: 3 });
  });

  it("chặn: buổi em vốn đã có tên, buổi đã dạy/đã hủy/đã qua ngày, lớp chỉ xem lịch, lớp đã đóng, xếp trùng", async () => {
    await expect(assign(ownNext.id)).rejects.toMatchObject({ code: "CONFLICT", message: "Học viên đã có tên trong buổi này." });
    await expect(assign(absent.id)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(assign(past.id)).rejects.toMatchObject({ code: "CONFLICT", message: "Buổi học bù đã qua ngày." });
    // Em không vắng buổi đó thì không có gì để bù.
    await expect(assign(target.id, f.admin, a2())).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(assign(target.id, f.admin, f.students[4]!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    await db.update(sessions).set({ status: "cancelled" }).where(eq(sessions.id, later.id));
    await expect(assign(later.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await db.update(classes).set({ timetableOnly: true }).where(eq(classes.id, f.classB.id));
    await expect(assign(target.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await db.update(classes).set({ timetableOnly: false, status: "closed" }).where(eq(classes.id, f.classB.id));
    await expect(assign(target.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await db.update(classes).set({ status: "open" }).where(eq(classes.id, f.classB.id));

    await assign(target.id);
    await db.update(sessions).set({ status: "planned" }).where(eq(sessions.id, later.id));
    await expect(assign(later.id)).rejects.toMatchObject({ code: "CONFLICT", message: "Buổi vắng này đã được xếp học bù." });
    expect(await db.select().from(makeupAssignments)).toHaveLength(1);
  });

  it("vắng buổi bù hoặc buổi bù bị hủy thì xếp lại được (thay lượt cũ); đã bù rồi thì không xếp nữa", async () => {
    await assign(target.id);
    await recordTarget("absent");
    // Vắng ở chính buổi học bù không sinh thêm một buổi cần bù.
    const list = await needs();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ date: "2026-01-06", state: "missed" });

    await assign(later.id);
    const rows = await db.select().from(makeupAssignments);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.makeupSessionId).toBe(later.id);

    await db.update(sessions).set({ status: "cancelled" }).where(eq(sessions.id, later.id));
    expect((await needs())[0]!.state).toBe("cancelled");
    // Xóa hẳn buổi bù thì lượt xếp mất theo, buổi vắng quay lại chưa xếp.
    await db.delete(sessions).where(eq(sessions.id, later.id));
    expect((await needs())[0]).toMatchObject({ state: "pending", assignmentId: null });
  });

  it("hủy xếp bù khi buổi bù chưa điểm danh; đã điểm danh thì không hủy được", async () => {
    const first = await assign(target.id);
    await makeupSvc.cancelMakeup(f.admin, first.id);
    expect((await needs())[0]!.state).toBe("pending");
    expect((await attendanceSvc.sessionRoster(db, target)).map((r) => r.code)).toEqual(["B1", "B2"]);

    const second = await assign(target.id);
    await recordTarget("present");
    await expect(makeupSvc.cancelMakeup(f.admin, second.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(makeupSvc.cancelMakeup(f.admin, first.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("theo quyền menu Ghi danh (Thêm để xếp, Sửa để hủy) và phạm vi lớp", async () => {
    await expect(needs(f.actorA)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(assign(target.id, f.actorA)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const viewOnly = withMenus(f.actorA, { enrollments: { view: true, add: false, edit: false } });
    expect(await needs(viewOnly)).toHaveLength(1);
    await expect(assign(target.id, viewOnly)).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Phạm vi lớp của mình: GV A thấy buổi vắng của lớp A nhưng không xếp được vào buổi của lớp B; GV B không thấy buổi vắng của lớp A.
    const ownA = withMenus(f.actorA, { enrollments: ALL }, "own");
    expect(await needs(ownA)).toHaveLength(1);
    expect((await makeupSvc.listMakeupTargets(ownA, TODAY)).map((t) => t.classCode)).toEqual(["A"]);
    await expect(assign(target.id, ownA)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const ownB = withMenus(f.actorB, { enrollments: ALL }, "own");
    expect(await needs(ownB)).toEqual([]);
    await expect(assign(target.id, ownB)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const row = await assign(target.id, withMenus(f.actorA, { enrollments: { view: true, add: true, edit: false } }));
    await expect(makeupSvc.cancelMakeup(withMenus(f.actorA, { enrollments: { view: true, add: true, edit: false } }), row.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await makeupSvc.cancelMakeup(withMenus(f.actorA, { enrollments: ALL }), row.id);
    expect(await db.select().from(makeupAssignments)).toEqual([]);
  });
});

describe("QL Học viên: chương trình đã học, lịch sử buổi học, tích lũy sao", () => {
  it("lịch sử gồm mọi lớp em từng học kèm tên bài; sao của buổi chỉ có với lớp trong phạm vi người xem", async () => {
    await starSvc.awardStars(f.admin, { sessionId: absent.id, criteriaId: plusThree, studentIds: [a2()], note: null }, NOW);
    const mine = await historySvc.getStudentLearningHistory(f.actorA, a2());
    expect(mine.programs).toHaveLength(1);
    expect(mine.programs[0]).toMatchObject({ classCode: "A", courseName: "Robotics", joinedAt: "2026-01-05", status: "active", taught: 1, attended: 1 });
    expect(mine.sessions).toEqual([
      expect.objectContaining({ date: "2026-01-06", classCode: "A", lesson: "Bài 3: Động cơ", status: "present", attended: true, stars: 3, isMakeup: false, makeup: null }),
    ]);
    // GV B không dạy A2 nên không xem được hồ sơ của em.
    await expect(historySvc.getStudentLearningHistory(f.actorB, a2())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("giáo viên của buổi học bù xem được em học ghép: thấy bài em đã học ở lớp khác, không thấy sao của lớp đó", async () => {
    await expect(historySvc.getStudentLearningHistory(f.actorB, a1())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await starSvc.awardStars(f.admin, { sessionId: absent.id, criteriaId: plusThree, studentIds: [a1()], note: null }, NOW);
    await assign(target.id);
    await recordTarget("present");

    const seen = await historySvc.getStudentLearningHistory(f.actorB, a1());
    expect(seen.programs.map((p) => `${p.classCode}|${p.attended}/${p.taught}`)).toEqual(["A|0/1"]);
    expect(seen.sessions).toEqual([
      expect.objectContaining({ date: "2026-01-15", classCode: "B", lesson: "Bài 5: Cảm biến", status: "present", isMakeup: true, stars: 0 }),
      expect.objectContaining({ date: "2026-01-06", classCode: "A", lesson: "Bài 3: Động cơ", status: "excused", isMakeup: false, makeup: "done", stars: null }),
    ]);
    // Admin thấy sao của mọi lớp.
    expect((await historySvc.getStudentLearningHistory(f.admin, a1())).sessions[1]!.stars).toBe(3);
  });

  it("danh sách học viên kèm tổng sao tích lũy", async () => {
    await starSvc.awardStars(f.admin, { sessionId: absent.id, criteriaId: plusThree, studentIds: [a2()], note: null }, NOW);
    const { rows } = await historySvc.listStudentsPageWithStars(f.admin, undefined, 1);
    expect(rows.map((s) => `${s.code}:${s.stars}`)).toEqual(["A1:0", "A2:3", "B1:0", "B2:0", "X1:0", "X2:0"]);
    // Ngoài Admin vẫn không nhận thông tin riêng tư.
    const own = await historySvc.listStudentsPageWithStars(withMenus(f.actorA, { students: ALL }, "own"), undefined, 1);
    expect(own.rows.map((s) => `${s.code}:${s.phone}`)).toEqual(["A1:null", "A2:null"]);
    expect(await db.select().from(attendances).where(and(eq(attendances.sessionId, absent.id), eq(attendances.studentId, a2())))).toHaveLength(1);
  });
});
