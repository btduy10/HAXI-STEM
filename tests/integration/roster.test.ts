import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { classes, classTeachers, enrollments, scheduleTemplates, sessions, students, teachers, timeSlots } from "@/db/schema";
import { ROSTER_DARKEST, ROSTER_LIGHTEST, ROSTER_NO_TEACHER_SHADE } from "@/domain/roster";
import { DEFAULT_PERMISSIONS, type RolePermissions } from "@/lib/permissions";
import type { Actor } from "@/server/guard";
import * as classSvc from "@/server/services/classes";
import { type Fixture, resetDb, seedFixture } from "./helpers";

// Tuần đang xem: Thứ Hai 12/01/2026 → Chủ nhật 18/01/2026 (hôm nay là Thứ Tư 14/01).
// Lịch mẫu: lớp A Tối Thứ 5 (hai khung của Ca tối) và Sáng Thứ 7; lớp B Tối Thứ 2. Mỗi lớp 2 học viên, GV chính A/B.
const TODAY = "2026-01-14";
let f: Fixture;
let evening: typeof timeSlots.$inferSelect;
let morning: typeof timeSlots.$inferSelect;

const withEnrollments = (actor: Actor, scope: RolePermissions["scope"]): Actor => ({
  ...actor,
  perms: { scope, menus: { ...DEFAULT_PERMISSIONS.teacher.menus, enrollments: { view: true, add: false, edit: false } } },
});
const roster = (actor: Actor = f.admin) => classSvc.weeklyRoster(actor, TODAY);
const titles = async (actor?: Actor) => (await roster(actor)).blocks.map((b) => `${b.label}|${b.classCode}`);
const hold = (values: Partial<typeof sessions.$inferInsert> & { classId: string; date: string }) =>
  db.insert(sessions).values({ startTime: "19:00", endTime: "20:30", timeSlotId: evening.id, ...values });

beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  const slots = await db
    .insert(timeSlots)
    .values([
      { name: "Ca tối", frame: 1, defaultStart: "18:00", defaultEnd: "19:30" },
      { name: "Ca tối", frame: 2, defaultStart: "19:30", defaultEnd: "21:00" },
      { name: "Ca sáng", frame: 1, defaultStart: "08:00", defaultEnd: "09:30" },
    ])
    .returning();
  evening = slots[0]!;
  morning = slots[2]!;
  await db.insert(scheduleTemplates).values([
    { classId: f.classA.id, weekday: 6, timeSlotId: morning.id },
    { classId: f.classA.id, weekday: 4, timeSlotId: evening.id },
    { classId: f.classA.id, weekday: 4, timeSlotId: slots[1]!.id },
    { classId: f.classB.id, weekday: 1, timeSlotId: evening.id },
  ]);
  await db.update(students).set({ schoolGrade: 5 }).where(eq(students.code, "A1"));
});

describe("tổng quan Ghi danh theo buổi trong tuần", () => {
  it("lớp không có buổi trong tuần lấy theo lịch mẫu: giờ của ca (gộp các khung), GV chính của lớp, kèm học viên và khối", async () => {
    const { blocks, unscheduled } = await roster();
    expect(blocks.map((b) => `${b.label}|${b.classCode}`)).toEqual(["Tối Thứ 2|B", "Tối Thứ 5|A", "Sáng Thứ 7|A"]);
    expect(unscheduled).toEqual([]);
    const [monday, thursday, saturday] = blocks;
    expect(monday).toMatchObject({ startTime: "18:00:00", endTime: "19:30:00", teacherName: "Giáo viên B", className: "Lớp B" });
    // Hai khung của Ca tối trong cùng Thứ Năm là một buổi, giờ từ khung sớm nhất tới khung muộn nhất.
    expect(thursday).toMatchObject({ classId: f.classA.id, startTime: "18:00:00", endTime: "21:00:00", teacherName: "Giáo viên A", maxSize: 3 });
    expect(thursday!.students.map((s) => s.fullName)).toEqual(["Học viên A1", "Học viên A2"]);
    // Kèm lượt ghi danh đang hiệu lực, để cho rời lớp hoặc xóa khỏi lớp ngay trên bảng.
    const [enrollmentA1] = await db.select().from(enrollments).where(eq(enrollments.studentId, f.students[0]!.id));
    expect(thursday!.students[0]).toEqual({ id: f.students[0]!.id, enrollmentId: enrollmentA1!.id, fullName: "Học viên A1", schoolGrade: 5 });
    // Lớp học 2 buổi/tuần: cùng danh sách học viên ở cả hai buổi.
    expect(saturday!.students).toEqual(thursday!.students);
  });

  it("lớp có buổi trên Thời khóa biểu tuần này thì theo Thời khóa biểu, không theo lịch mẫu", async () => {
    // Lịch mẫu của lớp A ghi Tối Thứ 5 và Sáng Thứ 7, nhưng tuần này lớp chỉ học Tối Thứ 7 (xếp tay).
    await db.update(teachers).set({ shortName: "Cô B" }).where(eq(teachers.id, f.teacherB.id));
    await hold({ classId: f.classA.id, date: "2026-01-17", teacherId: f.teacherA.id });
    // Buổi đã hủy, buổi bù và buổi của tuần khác không tạo thành buổi của tuần.
    await hold({ classId: f.classA.id, date: "2026-01-12", status: "cancelled" });
    await hold({ classId: f.classA.id, date: "2026-01-13", kind: "makeup" });
    await hold({ classId: f.classA.id, date: "2026-01-20" });

    const { blocks } = await roster();
    expect(blocks.map((b) => `${b.label}|${b.classCode}`)).toEqual(["Tối Thứ 2|B", "Tối Thứ 7|A"]);
    expect(blocks[1]).toMatchObject({ startTime: "19:00:00", endTime: "20:30:00", teacherName: "Giáo viên A" });

    // Có giáo viên dạy thay thì ghi người thực dạy (tên viết tắt nếu có).
    await db.update(sessions).set({ substituteTeacherId: f.teacherB.id }).where(eq(sessions.date, "2026-01-17"));
    expect((await roster()).blocks[1]!.teacherName).toBe("Cô B");
  });

  it("cùng một buổi: lớp học sớm hơn đứng trước; buổi không gắn ca suy ca theo giờ bắt đầu", async () => {
    await hold({ classId: f.classA.id, date: "2026-01-17", startTime: "19:30", endTime: "21:00" });
    await hold({ classId: f.classB.id, date: "2026-01-17", startTime: "18:00", endTime: "19:30" });
    await hold({ classId: f.classA.id, date: "2026-01-18", startTime: "09:00", endTime: "10:30", timeSlotId: null });
    await hold({ classId: f.classB.id, date: "2026-01-18", startTime: "14:00", endTime: "15:30", timeSlotId: null });
    expect(await titles()).toEqual(["Tối Thứ 7|B", "Tối Thứ 7|A", "Sáng Chủ nhật|A", "Chiều Chủ nhật|B"]);
  });

  it("màu khung theo giáo viên: các buổi của cùng một người cùng tông, đậm nhạt khác nhau; chưa có giáo viên thì xám", async () => {
    const tone = (color: string) => color.slice(6, -1).split(" ").map(Number);
    const headers = async () => (await roster()).blocks.map((b) => tone(b.shade.header));
    // Tối Thứ 2 (GV B) · Tối Thứ 5 (GV A) · Sáng Thứ 7 (GV A): GV A xếp trước theo mã nên nhận tông vàng, GV B tông xanh dương.
    const [monday, thursday, saturday] = await headers();
    expect([monday![2], thursday![2], saturday![2]]).toEqual([255, 75, 75]);
    // Hai buổi của GV A: buổi đầu nhạt nhất, buổi sau đậm nhất; GV B chỉ một buổi nên ở mức giữa.
    expect([thursday![0], saturday![0], monday![0]]).toEqual([ROSTER_LIGHTEST, ROSTER_DARKEST, 0.855]);

    // Dạy thay: buổi mang màu của người thực dạy (GV B giờ có hai buổi, GV A còn một).
    await hold({ classId: f.classA.id, date: "2026-01-17", teacherId: f.teacherA.id, substituteTeacherId: f.teacherB.id });
    await hold({ classId: f.classA.id, date: "2026-01-15", teacherId: f.teacherA.id });
    expect(await titles()).toEqual(["Tối Thứ 2|B", "Tối Thứ 5|A", "Tối Thứ 7|A"]);
    expect(await headers()).toEqual([
      [ROSTER_LIGHTEST, expect.any(Number), 255],
      [0.855, expect.any(Number), 75],
      [ROSTER_DARKEST, expect.any(Number), 255],
    ]);

    // Ba buổi của cùng một giáo viên xếp xen kẽ: nhạt nhất, đậm nhất, rồi mức giữa.
    await hold({ classId: f.classA.id, date: "2026-01-18", teacherId: f.teacherB.id });
    const ofB = (await headers()).filter(([, , hue]) => hue === 255).map(([lightness]) => lightness);
    expect(ofB).toEqual([ROSTER_LIGHTEST, ROSTER_DARKEST, 0.855]);
    await db.delete(sessions).where(eq(sessions.date, "2026-01-18"));

    // Buổi chưa có giáo viên (lớp không có GV chính, lịch mẫu không ghi giáo viên): xám trung tính.
    await db.delete(classTeachers).where(eq(classTeachers.classId, f.classB.id));
    expect((await roster()).blocks[0]!.shade).toEqual(ROSTER_NO_TEACHER_SHADE);
  });

  it("học viên mới vào lớp nằm ở hàng kế tiếp; em đã rời lớp không còn trong bảng", async () => {
    await classSvc.enrollStudent(f.admin, { classId: f.classA.id, studentId: f.students[4]!.id, joinedAt: "2026-02-01" });
    const [enrollment] = await db.select().from(enrollments).where(eq(enrollments.studentId, f.students[1]!.id));
    await classSvc.leaveEnrollment(f.admin, { id: enrollment!.id, leftAt: "2026-02-10" });
    const { blocks } = await roster();
    expect(blocks.find((b) => b.classCode === "A")!.students.map((s) => s.fullName)).toEqual(["Học viên A1", "Học viên X1"]);
  });

  it("không gồm lớp đã đóng và lớp chỉ hiển thị trên Thời khóa biểu; lớp chưa có buổi lẫn lịch mẫu nằm ở danh sách riêng", async () => {
    await db.update(classes).set({ status: "closed" }).where(eq(classes.id, f.classB.id));
    const [lend, fresh] = await db
      .insert(classes)
      .values([
        { code: "MP", name: "Mượn phòng", courseId: f.course.id, startDate: "2026-01-06", endDate: "2026-03-31", maxSize: 1, timetableOnly: true },
        { code: "M", name: "Lớp mới", courseId: f.course.id, startDate: "2026-01-06", endDate: "2026-03-31", maxSize: 8 },
      ])
      .returning();
    await db.insert(scheduleTemplates).values({ classId: lend!.id, weekday: 2, timeSlotId: evening.id });
    await hold({ classId: lend!.id, date: "2026-01-13" });
    await hold({ classId: f.classB.id, date: "2026-01-13" });
    const { blocks, unscheduled } = await roster();
    expect(blocks.map((b) => `${b.label}|${b.classCode}`)).toEqual(["Tối Thứ 5|A", "Sáng Thứ 7|A"]);
    expect(unscheduled).toEqual([{ id: fresh!.id, code: "M", name: "Lớp mới" }]);
  });

  it("theo quyền menu Ghi danh; phạm vi lớp của mình chỉ thấy lớp mình", async () => {
    // Giáo viên mặc định không có quyền menu Ghi danh.
    await expect(roster(f.actorA)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const own = await roster(withEnrollments(f.actorA, "own"));
    expect([...new Set(own.blocks.map((b) => b.classCode))]).toEqual(["A"]);
    const all = await roster(withEnrollments(f.actorA, "all"));
    expect([...new Set(all.blocks.map((b) => b.classCode))].sort()).toEqual(["A", "B"]);
  });
});
