import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attendances, auditLogs, classes, courses, enrollments, makeupAssignments, sessionStudents, sessions, starCriteria, starLogs, students, tuitionReceipts } from "@/db/schema";
import { lessonTitle } from "@/domain/syllabus";
import { DEFAULT_PERMISSIONS, type RolePermissions } from "@/lib/permissions";
import { newEnrollmentInput, studentHistoryDelete } from "@/lib/validation/entities";
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

describe("QL Học viên: số buổi đã học, chương trình học, lịch sử buổi học, tích lũy sao", () => {
  const progress = async (studentId: string, actor: Actor = f.admin) =>
    (await historySvc.getStudentLearningHistory(actor, studentId)).courses.map((c) => `${c.courseName}|${c.learned}/${c.totalSessions}`);
  /** Buổi đã dạy của một lớp với nội dung cho trước. */
  const taught = async (classId: string, teacherId: string, rows: [date: string, content: string][]) =>
    db
      .insert(sessions)
      .values(rows.map(([date, content]) => ({ classId, date, startTime: "18:00", endTime: "19:30", teacherId, status: "done" as const, content })))
      .returning();

  it("lịch sử gồm mọi lớp em từng học kèm tên bài; sao của buổi chỉ có với lớp trong phạm vi người xem", async () => {
    await starSvc.awardStars(f.admin, { sessionId: absent.id, criteriaId: plusThree, studentIds: [a2()], note: null }, NOW);
    const mine = await historySvc.getStudentLearningHistory(f.actorA, a2());
    // Nội dung buổi này giáo viên tự gõ nên không thuộc khóa nào.
    expect(mine.courses).toEqual([]);
    expect(mine.sessions).toEqual([
      expect.objectContaining({
        date: "2026-01-06",
        classCode: "A",
        className: f.classA.name,
        teacherName: f.teacherA.shortName || f.teacherA.fullName,
        status: "present",
        attended: true,
        stars: 3,
        isMakeup: false,
        makeup: null,
      }),
    ]);
    // Bài đã học: nội dung giáo viên tự gõ (không chọn từ Syllabus) nên không có số bài.
    expect(mine.lessons).toEqual([expect.objectContaining({ classCode: "A", className: f.classA.name, date: "2026-01-06", content: "Bài 3: Động cơ", lesson: null, isMakeup: false })]);
    // GV B không dạy A2 nên không xem được hồ sơ của em.
    await expect(historySvc.getStudentLearningHistory(f.actorB, a2())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("giáo viên của buổi học bù xem được em học ghép: thấy bài em đã học ở lớp khác, không thấy sao của lớp đó", async () => {
    await expect(historySvc.getStudentLearningHistory(f.actorB, a1())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await starSvc.awardStars(f.admin, { sessionId: absent.id, criteriaId: plusThree, studentIds: [a1()], note: null }, NOW);
    await assign(target.id);
    await recordTarget("present");

    const seen = await historySvc.getStudentLearningHistory(f.actorB, a1());
    expect(seen.courses).toEqual([]);
    expect(seen.sessions).toEqual([
      expect.objectContaining({ date: "2026-01-15", classCode: "B", teacherName: f.teacherB.shortName || f.teacherB.fullName, status: "present", isMakeup: true, stars: 0 }),
      expect.objectContaining({ date: "2026-01-06", classCode: "A", status: "excused", isMakeup: false, makeup: "done", stars: null }),
    ]);
    // Chỉ bài ở buổi em có mặt: bài của buổi vắng (lớp A) không tính, bài học bù ở lớp B có đánh dấu.
    expect(seen.lessons).toEqual([expect.objectContaining({ classCode: "B", content: "Bài 5: Cảm biến", isMakeup: true })]);
    // Admin thấy sao của mọi lớp.
    expect((await historySvc.getStudentLearningHistory(f.admin, a1())).sessions[1]!.stars).toBe(3);
  });

  it("đã học theo từng khóa: số buổi khác nhau của khóa em có mặt, kể cả học bù ở lớp khác, trên Tổng số buổi của khóa", async () => {
    const [second] = await db.insert(courses).values({ name: "Robotics 2", totalSessions: 12 }).returning();
    // Buổi 06/01 của lớp A dạy Buổi 1 của khóa Robotics: A2 có mặt, A1 vắng có phép.
    await db.update(sessions).set({ content: "Robotics · Buổi 1 – Làm quen" }).where(eq(sessions.id, absent.id));
    expect(await progress(a2())).toEqual(["Robotics|1/10"]);
    expect(await progress(a1())).toEqual([]);
    // A1 học bù ở lớp B, hôm đó lớp B cũng dạy Buổi 1 của khóa Robotics: xếp bù chưa đủ, có mặt mới tính cho khóa.
    await assign(target.id);
    expect(await progress(a1())).toEqual([]);
    await recordTarget("present");
    await db.update(sessions).set({ content: "robotics · Buổi 1 – Làm quen" }).where(eq(sessions.id, target.id));
    expect(await progress(a1())).toEqual(["Robotics|1/10"]);

    // Lớp A dạy tiếp, rồi học sang khóa Robotics 2 (một lớp học nhiều khóa).
    const made = await taught(f.classA.id, f.teacherA.id, [
      ["2026-01-07", "Robotics · Buổi 2 – Lắp ráp"], // đi trễ: tính
      ["2026-01-08", "Robotics · Buổi 2 – Lắp ráp"], // học lại cùng buổi: không tính hai lần
      ["2026-01-09", "Robotics · Buổi 3 – Động cơ"], // vắng: không tính
      ["2026-01-10", "Robotics · Buổi 4 – Cảm biến"], // buổi đã hủy: không tính
      ["2026-01-11", "Ôn tập"], // nội dung tự gõ: không thuộc khóa nào
      ["2026-01-12", "Buổi 5 – Nhãn cũ không kèm tên khóa"], // không thuộc khóa nào
      ["2026-01-14", "Robotics 2 · Buổi 1 – Tránh vật cản"],
    ]);
    const statuses = ["late", "left_early", "absent", "present", "present", "present", "present"] as const;
    await db.insert(attendances).values(made.map((session, i) => ({ sessionId: session.id, studentId: a2(), status: statuses[i]! })));
    await db.update(sessions).set({ status: "cancelled" }).where(eq(sessions.id, made[3]!.id));
    expect(await progress(a2())).toEqual(["Robotics|2/10", "Robotics 2|1/12"]);

    // Mẫu số là "Tổng số buổi" của khóa; khóa đã đổi tên thì không còn biết tổng số buổi.
    await db.update(courses).set({ totalSessions: 15 }).where(eq(courses.id, f.course.id));
    await db.update(courses).set({ name: "Robotics nâng cao" }).where(eq(courses.id, second!.id));
    expect((await historySvc.getStudentLearningHistory(f.admin, a2())).courses).toEqual([
      { courseName: "Robotics", learned: 2, totalSessions: 15 },
      { courseName: "Robotics 2", learned: 1, totalSessions: null },
    ]);
    // Rời lớp không làm mất số buổi đã học; em chưa học gì thì không có dòng nào.
    const [enrollment] = await db.select().from(enrollments).where(eq(enrollments.studentId, a2()));
    await classSvc.leaveEnrollment(f.admin, { id: enrollment!.id, leftAt: TODAY });
    expect(await progress(a2())).toEqual(["Robotics|2/15", "Robotics 2|1/null"]);
    expect(await progress(f.students[4]!.id)).toEqual([]);
    // Giáo viên của em thấy đủ, kể cả khóa em học ở lớp khác.
    expect(await progress(a1(), f.actorA)).toEqual(["Robotics|1/15"]);
  });

  it("chương trình học: mỗi bài em đã học xong một dòng, kèm tên khóa và số bài theo Buổi của Syllabus; một bài của một khóa chỉ một dòng dù học ở lớp nào", async () => {
    const titles = async (studentId: string) => (await historySvc.getStudentLearningHistory(f.admin, studentId)).lessons.map((l) => `${l.date} ${lessonTitle(l.content)}`);
    await db.update(sessions).set({ content: "Robotics · Buổi 3 – Động cơ" }).where(eq(sessions.id, absent.id));
    const made = await taught(f.classA.id, f.teacherA.id, [
      ["2026-01-07", "Robotics · Buổi 1 – Làm quen với robot"],
      ["2026-01-08", "Robotics · Buổi 3 – Động cơ"], // học lại Buổi 3
      ["2026-01-09", "Robotics · Buổi 4 – Cảm biến"], // vắng: chưa học Buổi 4
      ["2026-01-10", "  "], // buổi chưa ghi nội dung
      ["2026-01-11", "Ôn tập"], // nội dung tự gõ
      ["2026-01-12", "Tiết 2 – Nhãn cũ"], // nhãn cũ không kèm tên khóa
      ["2026-01-13", "Robotics 2 · Buổi 1 – Tránh vật cản"],
    ]);
    const statuses = ["late", "present", "absent", "present", "present", "present", "present"] as const;
    await db.insert(attendances).values(made.map((session, i) => ({ sessionId: session.id, studentId: a2(), status: statuses[i]! })));
    // Bài có tên khóa đứng trước, theo khóa rồi theo số bài; bài học hai lần lấy ngày học đầu tiên; sau đó là nhãn cũ và nội dung tự gõ.
    const expected = [
      "2026-01-07 Robotics · Bài 1: Làm quen với robot",
      "2026-01-06 Robotics · Bài 3: Động cơ",
      "2026-01-13 Robotics 2 · Bài 1: Tránh vật cản",
      "2026-01-12 Bài 2: Nhãn cũ",
      "2026-01-11 Ôn tập",
    ];
    expect(await titles(a2())).toEqual(expected);
    const [first] = (await historySvc.getStudentLearningHistory(f.admin, a2())).lessons;
    expect(first).toMatchObject({ classCode: "A", className: f.classA.name, isMakeup: false, lesson: { courseName: "Robotics", period: 1, title: "Làm quen với robot" } });

    // Học lại Buổi 1 của khóa Robotics ở lớp B: vẫn một dòng cho bài đó.
    const [again] = await taught(f.classB.id, f.teacherB.id, [["2026-01-14", "Robotics · Buổi 1 – Làm quen với robot"]]);
    await db.insert(attendances).values({ sessionId: again!.id, studentId: a2(), status: "present" });
    expect(await titles(a2())).toEqual(expected);
    // A1 vắng buổi 06/01 nên chưa có bài nào.
    expect(await titles(a1())).toEqual([]);
  });

  const history = (studentId: string) => historySvc.getStudentLearningHistory(f.admin, studentId);
  const remove = (studentId: string, sessionIds: string[] | "all", actor: Actor = f.admin) =>
    historySvc.deleteStudentHistory(actor, { studentId, sessionIds });

  it("Admin xóa một buổi khỏi lịch sử: mất điểm danh, sao của em trong buổi và lượt xếp học bù; học viên khác và buổi học giữ nguyên", async () => {
    // A1 vắng buổi 06/01 (đã xếp bù vào buổi 15/01 của lớp B); A1 và A2 đều được ghi sao trong buổi.
    await starSvc.awardStars(f.admin, { sessionId: absent.id, criteriaId: plusThree, studentIds: [a1(), a2()], note: null }, NOW);
    await assign(target.id);
    // Chỉ Admin: giáo viên của lớp, kể cả khi được tick đủ quyền QL Học viên và Ghi danh, không xóa được.
    await expect(remove(a1(), [absent.id], f.actorA)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(remove(a1(), [absent.id], withMenus(f.actorA, { students: ALL, enrollments: ALL }))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(studentHistoryDelete.safeParse({ studentId: a1(), sessionIds: [] }).success).toBe(false);
    expect((await history(a1())).sessions).toHaveLength(1);

    expect(await remove(a1(), [absent.id])).toEqual({ deletedAttendances: 1, deletedStarLogs: 1, deletedMakeups: 1, warnings: [] });
    expect((await history(a1())).sessions).toEqual([]);
    expect(await db.select().from(makeupAssignments)).toEqual([]);
    expect((await starSvc.starTotalsOf(db, [a1(), a2()])).get(a1()) ?? 0).toBe(0);
    // A2 cùng buổi: điểm danh và sao giữ nguyên; buổi học vẫn còn.
    expect((await history(a2())).sessions).toEqual([expect.objectContaining({ date: "2026-01-06", status: "present", stars: 3 })]);
    expect(await db.select().from(sessions).where(eq(sessions.id, absent.id))).toHaveLength(1);
    const [log] = await db.select().from(auditLogs).where(and(eq(auditLogs.tableName, "attendances"), eq(auditLogs.recordId, a1())));
    expect(log).toMatchObject({
      action: "delete",
      oldValue: [{ sessionId: absent.id, status: "excused" }],
      newValue: { deletedAttendances: 1, deletedStarLogs: 1, deletedMakeups: 1 },
    });
    // Không còn gì để xóa; học viên không tồn tại.
    await expect(remove(a1(), [absent.id])).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(remove(a1(), "all")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(remove(absent.id, "all")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("Admin xóa buổi em học bù: lượt xếp bù bị bỏ, buổi vắng quay lại chưa xếp bù", async () => {
    await assign(target.id);
    await recordTarget("present");
    expect((await history(a1())).lessons.map((l) => l.content)).toEqual(["Bài 5: Cảm biến"]);
    expect(await remove(a1(), [target.id])).toMatchObject({ deletedAttendances: 1, deletedMakeups: 1 });
    const after = await history(a1());
    expect(after.lessons).toEqual([]);
    expect(after.sessions).toEqual([expect.objectContaining({ date: "2026-01-06", makeup: "pending" })]);
    // Điểm danh của hai học viên lớp B ở buổi đó giữ nguyên.
    expect(await db.select().from(attendances).where(eq(attendances.sessionId, target.id))).toHaveLength(2);
  });

  it("Admin xóa một bài của chương trình học là xóa mọi buổi em đã học bài đó; xóa hết giữ lại buổi của lớp đã đóng", async () => {
    const made = await taught(f.classA.id, f.teacherA.id, [
      ["2026-01-07", "Robotics · Buổi 1 – Làm quen với robot"],
      ["2026-01-08", "Robotics · Buổi 1 – Làm quen với robot"], // học lại Buổi 1
      ["2026-01-09", "Robotics · Buổi 2 – Lắp ráp"],
    ]);
    const [inClassB] = await taught(f.classB.id, f.teacherB.id, [["2026-01-11", "Robotics · Buổi 4 – Cảm biến"]]);
    await db.insert(attendances).values([...made, inClassB!].map((s) => ({ sessionId: s.id, studentId: a2(), status: "present" as const })));
    const before = await history(a2());
    const lessonOne = before.lessons.find((l) => l.lesson?.period === 1)!;
    expect([...lessonOne.sessionIds].sort()).toEqual([made[0]!.id, made[1]!.id].sort());
    expect(before.courses).toEqual([expect.objectContaining({ courseName: "Robotics", learned: 3 })]);

    expect(await remove(a2(), lessonOne.sessionIds)).toMatchObject({ deletedAttendances: 2, warnings: [] });
    let now = await history(a2());
    expect(now.lessons.map((l) => l.content)).toEqual(["Robotics · Buổi 2 – Lắp ráp", "Robotics · Buổi 4 – Cảm biến", "Bài 3: Động cơ"]);
    expect(now.courses).toEqual([expect.objectContaining({ courseName: "Robotics", learned: 2 })]);
    expect(now.sessions).toHaveLength(3);

    // Lớp B đã đóng (tổng kết đã chốt): buổi của lớp đó không xóa được; "xóa hết" bỏ qua và báo lại.
    await db.update(classes).set({ status: "closed" }).where(eq(classes.id, f.classB.id));
    await expect(remove(a2(), [inClassB!.id])).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await remove(a2(), "all")).toMatchObject({ deletedAttendances: 2, warnings: [expect.stringContaining("1 buổi")] });
    now = await history(a2());
    expect(now.sessions.map((s) => s.date)).toEqual(["2026-01-11"]);
    expect(now.lessons.map((l) => l.content)).toEqual(["Robotics · Buổi 4 – Cảm biến"]);
    // Học viên khác của buổi 06/01 không bị đụng tới.
    expect((await history(a1())).sessions).toHaveLength(1);
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

describe("lịch học sắp tới trong hồ sơ học viên", () => {
  const schedule = async (studentId: string, actor: Actor = f.admin) =>
    (await historySvc.getStudentSchedule(actor, studentId, TODAY)).map((s) => `${s.date} ${s.classCode}${s.makeup ? " bù" : s.kind === "makeup" ? " buổi bù" : ""}`);
  const b1 = () => f.students[2]!.id;

  it("gồm buổi chưa dạy theo lịch của lớp em đang học và buổi học bù đã xếp ở Ghi danh, theo thứ tự ngày", async () => {
    // Buổi đã dạy, buổi đã qua ngày, buổi đã hủy không nằm trong lịch.
    expect(await schedule(a1())).toEqual(["2026-01-20 A"]);
    expect(await schedule(b1())).toEqual(["2026-01-15 B", "2026-01-22 B"]);
    await db.update(sessions).set({ status: "cancelled" }).where(eq(sessions.id, later.id));
    expect(await schedule(b1())).toEqual(["2026-01-15 B"]);

    await assign(target.id);
    expect(await schedule(a1())).toEqual(["2026-01-15 B bù", "2026-01-20 A"]);
    const [makeup, regular] = await historySvc.getStudentSchedule(f.admin, a1(), TODAY);
    expect(makeup).toMatchObject({
      sessionId: target.id,
      startTime: "18:00:00",
      endTime: "19:30:00",
      className: f.classB.name,
      teacherName: f.teacherB.shortName || f.teacherB.fullName,
      makeup: true,
      absentDate: "2026-01-06",
      absentClassCode: "A",
      absentClassName: f.classA.name,
    });
    expect(regular).toMatchObject({ sessionId: ownNext.id, makeup: false, absentDate: null, absentClassCode: null, absentClassName: null });
    // Hủy xếp bù thì buổi đó rời lịch của em.
    const [assignment] = await db.select().from(makeupAssignments);
    await makeupSvc.cancelMakeup(f.admin, assignment!.id);
    expect(await schedule(a1())).toEqual(["2026-01-20 A"]);
  });

  it("chỉ trong 28 ngày tới; chỉ khi em còn ghi danh vào ngày học; giáo viên dạy thay được hiện thay giáo viên của buổi", async () => {
    await db.insert(sessions).values([
      { classId: f.classA.id, date: "2026-02-10", startTime: "18:00", endTime: "19:30", teacherId: f.teacherA.id, substituteTeacherId: f.teacherB.id },
      { classId: f.classA.id, date: "2026-02-11", startTime: "18:00", endTime: "19:30", teacherId: f.teacherA.id },
    ]);
    expect(await schedule(a1())).toEqual(["2026-01-20 A", "2026-02-10 A"]);
    const rows = await historySvc.getStudentSchedule(f.admin, a1(), TODAY);
    expect(rows[1]!.teacherName).toBe(f.teacherB.shortName || f.teacherB.fullName);

    // Rời lớp từ 10/02: buổi từ ngày đó không còn trong lịch. Lớp đóng thì không còn lịch.
    const [enrollment] = await db.select().from(enrollments).where(eq(enrollments.studentId, a1()));
    await classSvc.leaveEnrollment(f.admin, { id: enrollment!.id, leftAt: "2026-02-10" });
    expect(await schedule(a1())).toEqual(["2026-01-20 A"]);
    await db.update(classes).set({ status: "closed" }).where(eq(classes.id, f.classA.id));
    expect(await schedule(a1())).toEqual([]);
    // Em chưa thuộc lớp nào: lịch trống.
    expect(await schedule(f.students[4]!.id)).toEqual([]);
  });

  it("buổi bù mở riêng cho lớp chỉ có trong lịch của em được chọn", async () => {
    const [extra] = await db
      .insert(sessions)
      .values({ classId: f.classA.id, date: "2026-01-17", startTime: "08:00", endTime: "09:30", teacherId: f.teacherA.id, kind: "makeup" })
      .returning();
    await db.insert(sessionStudents).values({ sessionId: extra!.id, studentId: a2() });
    expect(await schedule(a2())).toEqual(["2026-01-17 A buổi bù", "2026-01-20 A"]);
    expect(await schedule(a1())).toEqual(["2026-01-20 A"]);
  });

  it("theo quyền xem học viên: giáo viên lớp khác không xem được; giáo viên của em thấy cả buổi học bù ở lớp khác", async () => {
    await expect(schedule(a1(), f.actorB)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await assign(target.id);
    expect(await schedule(a1(), f.actorA)).toEqual(["2026-01-15 B bù", "2026-01-20 A"]);
    // Giáo viên của buổi học bù xem được hồ sơ và lịch của em học ghép.
    expect(await schedule(a1(), f.actorB)).toEqual(["2026-01-15 B bù", "2026-01-20 A"]);
  });
});
