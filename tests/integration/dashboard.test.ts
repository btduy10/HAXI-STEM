import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attendances, classes, rooms, sessions, starLogs } from "@/db/schema";
import { centerToday, dashboardCharts } from "@/server/services/dashboard";
import { type Fixture, resetDb, seedFixture } from "./helpers";

let f: Fixture;
// Thứ Tư 21/01/2026 (giờ Việt Nam). Tuần hiện tại bắt đầu Thứ Hai 19/01.
const now = new Date("2026-01-21T05:00:00Z");

beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  const base = { startTime: "08:00", endTime: "09:30", status: "done" as const };
  const [a1, a2, b1, old] = await db
    .insert(sessions)
    .values([
      { ...base, classId: f.classA.id, date: "2026-01-13" },
      { ...base, classId: f.classA.id, date: "2026-01-20" },
      { ...base, classId: f.classB.id, date: "2026-01-20" },
      { ...base, classId: f.classA.id, date: "2025-11-04" }, // ngoài 30 ngày và ngoài 8 tuần
    ])
    .returning();
  const [sA1, sA2, sB1, sB2] = f.students;
  await db.insert(attendances).values([
    { sessionId: a1!.id, studentId: sA1!.id, status: "present" },
    { sessionId: a1!.id, studentId: sA2!.id, status: "absent" },
    { sessionId: a2!.id, studentId: sA1!.id, status: "late" },
    { sessionId: a2!.id, studentId: sA2!.id, status: "excused" },
    { sessionId: b1!.id, studentId: sB1!.id, status: "present" },
    { sessionId: b1!.id, studentId: sB2!.id, status: "present" },
    { sessionId: old!.id, studentId: sA1!.id, status: "absent" },
  ]);
  await db.insert(starLogs).values([
    { sessionId: a1!.id, studentId: sA1!.id, stars: 25 },
    { sessionId: a2!.id, studentId: sA1!.id, stars: -2 },
    { sessionId: a2!.id, studentId: sA2!.id, stars: 3 },
    { sessionId: b1!.id, studentId: sB1!.id, stars: 5 },
    { sessionId: old!.id, studentId: sA2!.id, stars: 9 },
  ]);
});

describe("số liệu biểu đồ trang Tổng quan", () => {
  it("Admin thấy toàn trung tâm", async () => {
    const data = await dashboardCharts(f.admin, now);
    expect(data.attendance).toEqual({ present: 3, late: 1, left_early: 0, excused: 1, absent: 1 });
    // Lớp A: 5 lượt (tính cả buổi cũ), có đi học 2 → 40%; lớp B: 2/2 → 100%.
    expect(data.classRates.map((c) => [c.code, c.rate, c.total])).toEqual([["A", 40, 5], ["B", 100, 2]]);
    expect(data.starsByWeek).toHaveLength(8);
    expect(data.starsByWeek.at(-1)).toEqual({ weekStart: "2026-01-19", stars: 6 }); // -2 + 3 + 5
    expect(data.starsByWeek.at(-2)).toEqual({ weekStart: "2026-01-12", stars: 25 });
    expect(data.starsByWeek.slice(0, 6).every((w) => w.stars === 0)).toBe(true);
  });

  it("GV chỉ thấy số liệu các lớp của mình", async () => {
    const data = await dashboardCharts(f.actorA, now);
    expect(data.attendance).toEqual({ present: 1, late: 1, left_early: 0, excused: 1, absent: 1 });
    expect(data.classRates.map((c) => c.code)).toEqual(["A"]);
    expect(data.starsByWeek.at(-1)!.stars).toBe(1);

    const other = await dashboardCharts(f.actorB, now);
    expect(other.classRates.map((c) => c.code)).toEqual(["B"]);
    expect(other.starsByWeek.at(-1)!.stars).toBe(5);
  });

  it("tài khoản GV không gắn giáo viên nhận số liệu rỗng", async () => {
    const data = await dashboardCharts({ ...f.actorA, teacherId: null }, now);
    expect(data.attendance).toEqual({ present: 0, late: 0, left_early: 0, excused: 0, absent: 0 });
    expect(data.classRates).toEqual([]);
    expect(data.starsByWeek.every((w) => w.stars === 0)).toBe(true);
  });
});

describe("giao diện 3D trung tâm ở trang Tổng quan", () => {
  // Hôm nay (21/01): lớp A có buổi sáng, lớp B có buổi chiều (thầy B dạy, thầy A dạy thay) và một buổi tối đã hủy, chưa xếp phòng.
  const seedToday = async () => {
    const [lab2] = await db.insert(rooms).values({ name: "Lab 2", capacity: 6 }).returning();
    const [morning, afternoon, evening] = await db
      .insert(sessions)
      .values([
        { classId: f.classA.id, date: "2026-01-21", startTime: "08:00", endTime: "09:30", roomId: f.room.id, teacherId: f.teacherA.id },
        { classId: f.classB.id, date: "2026-01-21", startTime: "14:00", endTime: "15:30", roomId: lab2!.id, teacherId: f.teacherB.id, substituteTeacherId: f.teacherA.id },
        { classId: f.classB.id, date: "2026-01-21", startTime: "18:00", endTime: "19:30", teacherId: f.teacherB.id, status: "cancelled" },
        { classId: f.classA.id, date: "2026-01-22", startTime: "08:00", endTime: "09:30", roomId: f.room.id, teacherId: f.teacherA.id }, // ngày mai: không tính
      ])
      .returning();
    return { lab2: lab2!, morning: morning!, afternoon: afternoon!, evening: evening! };
  };
  const hrefOf = (s: { id: string }) => `/x/${s.id}`;

  it("Admin thấy mọi phòng và mọi buổi hôm nay; chỉ có tên lớp, người thực dạy, giờ, sĩ số", async () => {
    const { lab2, morning, afternoon, evening } = await seedToday();
    const data = await centerToday(f.admin, hrefOf, now);
    expect(data.today).toBe("2026-01-21");
    expect(data.now).toBe("12:00");
    expect(data.rooms).toEqual([
      { id: f.room.id, name: "Lab", capacity: 10 },
      { id: lab2.id, name: "Lab 2", capacity: 6 },
    ]);
    expect(data.sessions).toEqual([
      { id: morning.id, roomId: f.room.id, className: "Lớp A", teacherName: "Giáo viên A", startTime: "08:00", endTime: "09:30", cancelled: false, timetableOnly: false, studentCount: 2, href: `/x/${morning.id}` },
      // Người thực dạy là giáo viên dạy thay.
      { id: afternoon.id, roomId: lab2.id, className: "Lớp B", teacherName: "Giáo viên A", startTime: "14:00", endTime: "15:30", cancelled: false, timetableOnly: false, studentCount: 2, href: `/x/${afternoon.id}` },
      { id: evening.id, roomId: null, className: "Lớp B", teacherName: "Giáo viên B", startTime: "18:00", endTime: "19:30", cancelled: true, timetableOnly: false, studentCount: 2, href: `/x/${evening.id}` },
    ]);
    // Không có tên, mã hay thông tin nào của học viên được gửi xuống trình duyệt.
    const sent = JSON.stringify(data);
    for (const student of f.students) {
      expect(sent).not.toContain(student.fullName);
      expect(sent).not.toContain(student.id);
    }
    expect(sent).not.toContain("0900000000");
  });

  it("giáo viên phạm vi lớp của mình: chỉ buổi của lớp mình và buổi mình dạy thay; lớp chỉ hiển thị trên Thời khóa biểu không có sĩ số", async () => {
    const { morning, afternoon } = await seedToday();
    // Thầy A: buổi của lớp A và buổi dạy thay ở lớp B; không thấy buổi tối của lớp B.
    const mine = await centerToday(f.actorA, hrefOf, now);
    expect(mine.sessions.map((s) => s.id)).toEqual([morning.id, afternoon.id]);
    expect(mine.rooms).toHaveLength(2);
    // Thầy B: chỉ các buổi của lớp B.
    expect((await centerToday(f.actorB, hrefOf, now)).sessions.map((s) => s.className)).toEqual(["Lớp B", "Lớp B"]);
    // Tài khoản giáo viên không gắn giáo viên: không có buổi nào.
    expect((await centerToday({ ...f.actorA, teacherId: null }, hrefOf, now)).sessions).toEqual([]);

    await db.update(classes).set({ timetableOnly: true }).where(eq(classes.id, f.classA.id));
    const [lent] = (await centerToday(f.admin, () => null, now)).sessions;
    expect(lent).toMatchObject({ className: "Lớp A", timetableOnly: true, studentCount: null, href: null });
  });
});
