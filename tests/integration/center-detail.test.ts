import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attendances, classes, sessions, starCriteria, starLogs } from "@/db/schema";
import { DEFAULT_PERMISSIONS, NO_PERMISSIONS } from "@/lib/permissions";
import type { Actor } from "@/server/guard";
import { searchStudents, sessionDetail, sessionWorkspace, studentDetail, teacherWeek } from "@/server/services/center-detail";
import { type Fixture, resetDb, seedFixture } from "./helpers";

// Chi tiết của dashboard 3D (tải khi người dùng mở một buổi, một học viên, một giáo viên): đúng số liệu và đúng phân quyền.

let f: Fixture;
let morning: typeof sessions.$inferSelect;
let afternoon: typeof sessions.$inferSelect;
let friday: typeof sessions.$inferSelect;
// Thứ Tư 21/01/2026, 12:00 giờ Việt Nam. Tuần hiện tại: 19/01 → 25/01.
const now = new Date("2026-01-21T05:00:00Z");
let duty: Actor;
let bare: Actor;

beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  // Giáo viên trực: xem mọi lớp, điểm danh, xem học viên; KHÔNG có quyền Sao. Vai trò trắng: không có quyền gì.
  duty = { userId: f.actorA.userId, role: "duty_teacher", teacherId: null, perms: DEFAULT_PERMISSIONS.duty_teacher };
  bare = { ...f.actorA, perms: NO_PERMISSIONS };
  [morning, afternoon, friday] = (await db
    .insert(sessions)
    .values([
      // Buổi sáng của lớp A (thầy A), đã điểm danh. Buổi chiều của lớp B (thầy B), chưa điểm danh.
      { classId: f.classA.id, date: "2026-01-21", startTime: "08:00", endTime: "09:30", roomId: f.room.id, teacherId: f.teacherA.id, status: "done" },
      { classId: f.classB.id, date: "2026-01-21", startTime: "14:00", endTime: "15:30", roomId: f.room.id, teacherId: f.teacherB.id },
      // Thứ Sáu: lớp B, thầy B dạy chính, thầy A dạy thay.
      { classId: f.classB.id, date: "2026-01-23", startTime: "14:00", endTime: "15:30", teacherId: f.teacherB.id, substituteTeacherId: f.teacherA.id },
      // Tuần sau: không tính vào "tuần này".
      { classId: f.classA.id, date: "2026-01-28", startTime: "08:00", endTime: "09:30", teacherId: f.teacherA.id },
    ])
    .returning()) as [typeof morning, typeof afternoon, typeof friday, typeof morning];
  const [a1, a2] = f.students;
  await db.insert(attendances).values([
    { sessionId: morning.id, studentId: a1!.id, status: "present", recordedAt: new Date("2026-01-21T01:05:00Z") },
    { sessionId: morning.id, studentId: a2!.id, status: "absent", recordedAt: new Date("2026-01-21T01:06:00Z") },
  ]);
  await db.insert(starLogs).values([
    { sessionId: morning.id, studentId: a1!.id, stars: 5, recordedAt: new Date("2026-01-21T01:40:00Z") },
    { sessionId: morning.id, studentId: a1!.id, stars: -2, recordedAt: new Date("2026-01-21T01:50:00Z") },
  ]);
});

describe("chi tiết một buổi học trên dashboard", () => {
  it("Admin: lớp, người dạy, sĩ số, tỉ lệ điểm danh, danh sách học viên kèm sao và mốc thời gian; không có thông tin cá nhân", async () => {
    const detail = await sessionDetail(f.admin, morning.id);
    expect(detail).toMatchObject({ className: "Lớp A", classCode: "A", teacherName: "Giáo viên A", startTime: "08:00", endTime: "09:30", roomName: "Lab" });
    expect(detail).toMatchObject({ enrolled: 2, recorded: true, marked: 2, attended: 1, rate: 50, seesStars: true, cancelled: false });
    expect(detail.students.map((s) => [s.code, s.status, s.sessionStars, s.total])).toEqual([
      ["A1", "present", 3, 3],
      ["A2", "absent", 0, 0],
    ]);
    // Mốc thời gian thật: lúc điểm danh đầu tiên 08:05, lúc ghi sao đầu tiên 08:40 (giờ Việt Nam).
    expect(detail.timeline.attendanceAt).toContain("08:05");
    expect(detail.timeline.starsAt).toContain("08:40");
    expect(detail.timeline.scheduledAt).toBeTruthy();
    expect(JSON.stringify(detail)).not.toContain("0900000000");

    // Buổi chưa điểm danh: chưa có tỉ lệ, học viên chưa có trạng thái.
    const pending = await sessionDetail(f.admin, afternoon.id);
    expect(pending).toMatchObject({ recorded: false, rate: null, attended: 0, timeline: { attendanceAt: null, starsAt: null } });
    expect(pending.students.map((s) => s.status)).toEqual([null, null]);
  });

  it("buổi có người dạy thay: ghi người thực dạy và giáo viên được thay", async () => {
    expect(await sessionDetail(f.admin, friday.id)).toMatchObject({ teacherName: "Giáo viên A", replacedTeacherName: "Giáo viên B" });
  });

  it("giáo viên chỉ đọc được buổi trong phạm vi của mình, kể cả khi gọi thẳng bằng id", async () => {
    expect((await sessionDetail(f.actorA, morning.id)).students).toHaveLength(2);
    await expect(sessionDetail(f.actorA, afternoon.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(sessionDetail(f.actorB, morning.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Buổi dạy thay ở lớp khác: người dạy thay vào được đúng buổi đó.
    expect((await sessionDetail(f.actorA, friday.id)).className).toBe("Lớp B");
    await expect(sessionWorkspace(f.actorB, morning.id, now)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("vai trò không có quyền Sao (Giáo viên trực) không nhận số sao; vai trò không có quyền Điểm danh bị từ chối", async () => {
    const detail = await sessionDetail(duty, morning.id);
    expect(detail.seesStars).toBe(false);
    expect(detail.students.map((s) => [s.code, s.status, s.sessionStars, s.total])).toEqual([
      ["A1", "present", null, null],
      ["A2", "absent", null, null],
    ]);
    expect(detail.timeline.starsAt).toBeNull();
    await expect(sessionDetail(bare, morning.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(sessionWorkspace(bare, morning.id, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("lớp chỉ hiển thị trên Thời khóa biểu không có chi tiết học viên", async () => {
    await db.update(classes).set({ timetableOnly: true }).where(eq(classes.id, f.classA.id));
    await expect(sessionDetail(f.admin, morning.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(sessionWorkspace(f.admin, morning.id, now)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("điểm danh và ghi sao trên dashboard dùng đúng bảng của hai trang hiện có", () => {
  it("giáo viên của lớp nhận bảng điểm danh và bảng ghi sao của buổi", async () => {
    await db.insert(starCriteria).values({ name: "Hăng hái", stars: 2, type: "reward" });
    const space = await sessionWorkspace(f.actorA, morning.id, now);
    expect(space.session).toMatchObject({ classCode: "A", className: "Lớp A", startTime: "08:00" });
    expect(space.attendance).toMatchObject({ recorded: true, blockedReason: null });
    expect(space.attendance!.rows.map((r) => [r.code, r.status])).toEqual([["A1", "present"], ["A2", "absent"]]);
    expect(space.stars).toMatchObject({ canAward: true, blockedReason: null });
    expect(space.stars!.criteria.map((c) => c.name)).toEqual(["Hăng hái"]);
    expect(space.stars!.students.map((s) => [s.code, s.sessionStars, s.total])).toEqual([["A1", 3, 3], ["A2", 0, 0]]);
    expect(space.stars!.logs).toHaveLength(2);
  });

  it("Giáo viên trực chỉ nhận phần điểm danh; buổi của ngày chưa tới bị chặn với đúng lý do", async () => {
    const space = await sessionWorkspace(duty, morning.id, now);
    expect(space.stars).toBeNull();
    expect(space.attendance!.rows).toHaveLength(2);
    const future = await sessionWorkspace(f.admin, friday.id, now);
    expect(future.attendance!.blockedReason).toBe("Chưa đến ngày học.");
    expect(future.stars!.blockedReason).toBe("Chưa đến ngày học.");
  });
});

describe("thẻ học viên, thẻ giáo viên và tìm học viên trên dashboard", () => {
  it("thẻ học viên: mã, lớp đang học, tổng sao, lịch sử điểm danh; không có thông tin cá nhân", async () => {
    const [a1] = f.students;
    const detail = await studentDetail(f.actorA, a1!.id);
    expect(detail).toMatchObject({ code: "A1", fullName: "Học viên A1", total: 3, classes: [{ id: f.classA.id, name: "Lớp A" }] });
    expect(detail.attendance).toEqual([{ sessionId: morning.id, date: "2026-01-21", startTime: "08:00", classCode: "A", status: "present", stars: 3 }]);
    expect(Object.keys(detail).sort()).toEqual(["attendance", "classes", "code", "fullName", "id", "total"]);
    expect(JSON.stringify(detail)).not.toContain("0900000000");
  });

  it("giáo viên không đọc được học viên của lớp khác; không có quyền Sao thì không có số sao; không có quyền QL Học viên thì bị từ chối", async () => {
    const [a1, , b1] = f.students;
    await expect(studentDetail(f.actorA, b1!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(studentDetail(f.actorB, a1!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const seen = await studentDetail(duty, a1!.id);
    expect(seen.total).toBeNull();
    expect(seen.attendance.map((a) => a.stars)).toEqual([null]);
    await expect(studentDetail(bare, a1!.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("thẻ giáo viên: các buổi trong tuần này gom theo lớp, kèm vai trò; người chỉ thấy lớp của mình chỉ nhận buổi trong phạm vi", async () => {
    const week = await teacherWeek(f.admin, f.teacherA.id, now);
    expect(week).toMatchObject({ from: "2026-01-19", to: "2026-01-25", total: 2 });
    expect(week.classes.map((c) => [c.className, c.sessions.map((s) => `${s.date} ${s.startTime} ${s.role} ${s.status}`)])).toEqual([
      ["Lớp A", ["2026-01-21 08:00 main done"]],
      ["Lớp B", ["2026-01-23 14:00 substitute planned"]],
    ]);
    // Thầy B được thay ở buổi Thứ Sáu.
    const other = await teacherWeek(f.admin, f.teacherB.id, now);
    expect(other.classes.flatMap((c) => c.sessions.map((s) => `${s.date} ${s.role}`))).toEqual(["2026-01-21 main", "2026-01-23 replaced"]);
    // Thầy B xem lịch của thầy A: chỉ thấy buổi thuộc lớp của thầy B.
    const scoped = await teacherWeek(f.actorB, f.teacherA.id, now);
    expect(scoped.classes.map((c) => c.className)).toEqual(["Lớp B"]);
    // Tài khoản giáo viên không gắn giáo viên: không có buổi nào.
    expect((await teacherWeek({ ...f.actorA, teacherId: null }, f.teacherA.id, now)).total).toBe(0);
  });

  it("tìm học viên: theo tên hoặc mã, trong phạm vi lớp của người tìm; chỉ trả mã, tên, lớp đang học", async () => {
    const all = await searchStudents(f.admin, "Học viên");
    expect(all.map((s) => s.code)).toEqual(["A1", "A2", "B1", "B2", "X1", "X2"]);
    expect(all[0]).toEqual({ id: f.students[0]!.id, code: "A1", fullName: "Học viên A1", classes: [{ id: f.classA.id, name: "Lớp A" }] });
    // Học viên chưa thuộc lớp nào: không có lớp đang học.
    expect(all.at(-1)!.classes).toEqual([]);
    expect((await searchStudents(f.actorA, "học viên")).map((s) => s.code)).toEqual(["A1", "A2"]);
    expect(await searchStudents(f.actorB, "A1")).toEqual([]);
    expect((await searchStudents(f.actorB, "b2")).map((s) => s.fullName)).toEqual(["Học viên B2"]);
    await expect(searchStudents(bare, "Học viên")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(JSON.stringify(all)).not.toContain("0900000000");
  });
});
