import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { classes, classTeachers, enrollments, scheduleTemplates, sessions, students, teachers, timeSlots } from "@/db/schema";
import { ROSTER_DARKEST, ROSTER_LIGHTEST, ROSTER_NO_TEACHER_SHADE } from "@/domain/roster";
import { addDays, startOfWeek } from "@/lib/dates";
import { todayIso } from "@/lib/format";
import { DEFAULT_PERMISSIONS, type RolePermissions } from "@/lib/permissions";
import type { Actor } from "@/server/guard";
import * as classSvc from "@/server/services/classes";
import { type Fixture, resetDb, seedFixture } from "./helpers";

// Bảng lấy theo LỊCH MẪU của lớp, không đọc Thời khóa biểu.
// Lịch mẫu: lớp A Tối Thứ 5 (hai khung của Ca tối) và Sáng Thứ 7; lớp B Tối Thứ 2. Mỗi lớp 2 học viên, GV chính A/B.
let f: Fixture;
let evening: typeof timeSlots.$inferSelect;
let morning: typeof timeSlots.$inferSelect;
let afternoon: typeof timeSlots.$inferSelect;
let lateEvening: typeof timeSlots.$inferSelect;

const withEnrollments = (actor: Actor, scope: RolePermissions["scope"]): Actor => ({
  ...actor,
  perms: { scope, menus: { ...DEFAULT_PERMISSIONS.teacher.menus, enrollments: { view: true, add: false, edit: false } } },
});
const roster = (actor: Actor = f.admin) => classSvc.weeklyRoster(actor);
type Block = Awaited<ReturnType<typeof roster>>["blocks"][number];
// Tên khung: các buổi của khung theo thứ tự từ trên xuống, rồi mã lớp.
const title = (b: Block) => `${b.sessions.map((s) => s.label).join(" + ")}|${b.classCode}`;
const titles = async (actor?: Actor) => (await roster(actor)).blocks.map(title);
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
      { name: "Ca chiều", frame: 1, defaultStart: "14:00", defaultEnd: "15:30" },
    ])
    .returning();
  evening = slots[0]!;
  lateEvening = slots[1]!;
  morning = slots[2]!;
  afternoon = slots[3]!;
  await db.insert(scheduleTemplates).values([
    { classId: f.classA.id, weekday: 6, timeSlotId: morning.id },
    { classId: f.classA.id, weekday: 4, timeSlotId: evening.id },
    { classId: f.classA.id, weekday: 4, timeSlotId: slots[1]!.id },
    { classId: f.classB.id, weekday: 1, timeSlotId: evening.id },
  ]);
  await db.update(students).set({ schoolGrade: 5 }).where(eq(students.code, "A1"));
});

describe("tổng quan Ghi danh theo buổi trong tuần", () => {
  it("theo lịch mẫu của lớp: giờ của ca (gộp các khung), GV chính của lớp, kèm học viên và khối", async () => {
    const { blocks, unscheduled } = await roster();
    // Lớp A học 2 buổi/tuần với cùng giáo viên: một khung, buổi sớm hơn trong tuần nằm trên.
    expect(blocks.map(title)).toEqual(["Tối Thứ 2|B", "Tối Thứ 5 + Sáng Thứ 7|A"]);
    expect(unscheduled).toEqual([]);
    const [monday, classA] = blocks;
    expect(monday).toMatchObject({
      sessions: [{ label: "Tối Thứ 2", startTime: "18:00:00", endTime: "19:30:00" }],
      teacherName: "Giáo viên B",
      className: "Lớp B",
    });
    // Hai khung của Ca tối trong cùng Thứ Năm là một buổi, giờ từ khung sớm nhất tới khung muộn nhất.
    expect(classA).toMatchObject({
      classId: f.classA.id,
      sessions: [
        { label: "Tối Thứ 5", startTime: "18:00:00", endTime: "21:00:00" },
        { label: "Sáng Thứ 7", startTime: "08:00:00", endTime: "09:30:00" },
      ],
      teacherName: "Giáo viên A",
      maxSize: 3,
    });
    expect(classA!.students.map((s) => s.fullName)).toEqual(["Học viên A1", "Học viên A2"]);
    // Kèm lượt ghi danh đang hiệu lực, để cho rời lớp hoặc xóa khỏi lớp ngay trên bảng.
    const [enrollmentA1] = await db.select().from(enrollments).where(eq(enrollments.studentId, f.students[0]!.id));
    expect(classA!.students[0]).toEqual({ id: f.students[0]!.id, enrollmentId: enrollmentA1!.id, fullName: "Học viên A1", schoolGrade: 5 });
  });

  it("cùng lớp, cùng giáo viên gom một khung theo thứ tự buổi trong tuần; buổi của giáo viên khác là khung riêng", async () => {
    // Lớp A học Tối Chủ nhật và Chiều Thứ 7, cùng GV A: một khung, Chiều Thứ 7 nằm trên Tối Chủ nhật.
    await db.delete(scheduleTemplates).where(eq(scheduleTemplates.classId, f.classA.id));
    const [sunday] = await db
      .insert(scheduleTemplates)
      .values([
        { classId: f.classA.id, weekday: 7, timeSlotId: evening.id },
        { classId: f.classA.id, weekday: 6, timeSlotId: afternoon.id, teacherId: f.teacherA.id },
      ])
      .returning();
    const merged = (await roster()).blocks;
    expect(merged.map(title)).toEqual(["Tối Thứ 2|B", "Chiều Thứ 7 + Tối Chủ nhật|A"]);
    expect(merged[1]!.sessions.map((s) => `${s.startTime}-${s.endTime}`)).toEqual(["14:00:00-15:30:00", "18:00:00-19:30:00"]);
    expect(merged[1]!.students).toHaveLength(2);

    // Dòng Chủ nhật do GV B dạy: lớp A có hai khung, mỗi giáo viên một khung, cùng danh sách học viên.
    await db.update(scheduleTemplates).set({ teacherId: f.teacherB.id }).where(eq(scheduleTemplates.id, sunday!.id));
    const split = (await roster()).blocks;
    expect(split.map((b) => `${title(b)}|${b.teacherName}`)).toEqual([
      "Tối Thứ 2|B|Giáo viên B",
      "Chiều Thứ 7|A|Giáo viên A",
      "Tối Chủ nhật|A|Giáo viên B",
    ]);
    expect(split[2]!.students).toEqual(split[1]!.students);
    expect(new Set(split.map((b) => b.key)).size).toBe(3);
  });

  it("không đọc Thời khóa biểu: buổi xếp tay, buổi dời, dạy thay trong tuần không làm đổi bảng", async () => {
    await db.update(teachers).set({ shortName: "Cô B" }).where(eq(teachers.id, f.teacherB.id));
    const before = await roster();
    // Tuần này lớp A học Tối Thứ 7 do GV B dạy thay, thêm một buổi xếp tay Chủ nhật; lớp B không có buổi nào.
    const monday = startOfWeek(todayIso());
    await hold({ classId: f.classA.id, date: addDays(monday, 5), teacherId: f.teacherA.id, substituteTeacherId: f.teacherB.id });
    await hold({ classId: f.classA.id, date: addDays(monday, 6), startTime: "09:00", endTime: "10:30", timeSlotId: null });
    await hold({ classId: f.classA.id, date: addDays(monday, 7), kind: "makeup" });
    expect(await roster()).toEqual(before);
    expect(before.blocks.map((b) => `${title(b)}|${b.teacherName}`)).toEqual(["Tối Thứ 2|B|Cô B", "Tối Thứ 5 + Sáng Thứ 7|A|Giáo viên A"]);
  });

  it("khung đứng theo buổi đầu tuần của nó; cùng một buổi thì lớp học sớm hơn đứng trước", async () => {
    await db.delete(scheduleTemplates);
    await db.insert(scheduleTemplates).values([
      { classId: f.classA.id, weekday: 6, timeSlotId: lateEvening.id },
      { classId: f.classA.id, weekday: 7, timeSlotId: morning.id },
      { classId: f.classB.id, weekday: 6, timeSlotId: evening.id },
      { classId: f.classB.id, weekday: 7, timeSlotId: afternoon.id },
    ]);
    expect(await titles()).toEqual(["Tối Thứ 7 + Chiều Chủ nhật|B", "Tối Thứ 7 + Sáng Chủ nhật|A"]);
    // Lớp A có thêm buổi Sáng Thứ 2: khung của lớp A lên đầu.
    await db.insert(scheduleTemplates).values({ classId: f.classA.id, weekday: 1, timeSlotId: morning.id });
    expect(await titles()).toEqual(["Sáng Thứ 2 + Tối Thứ 7 + Sáng Chủ nhật|A", "Tối Thứ 7 + Chiều Chủ nhật|B"]);
  });

  it("màu khung theo giáo viên: các khung của cùng một người cùng tông, đậm nhạt khác nhau; chưa có giáo viên thì xám", async () => {
    const tone = (color: string) => color.slice(6, -1).split(" ").map(Number);
    const headers = async () => (await roster()).blocks.map((b) => tone(b.shade.header));
    // Tối Thứ 2 (GV B) · Tối Thứ 5 + Sáng Thứ 7 (GV A): GV A xếp trước theo mã nên nhận tông vàng, GV B tông xanh dương.
    const [monday, classA] = await headers();
    expect([monday![2], classA![2]]).toEqual([255, 75]);
    // Mỗi giáo viên chỉ một khung (hai buổi của GV A đã gom) nên đều ở mức giữa.
    expect([monday![0], classA![0]]).toEqual([0.855, 0.855]);

    // Dòng Sáng Thứ 7 của lớp A giao cho GV B: khung mang màu của giáo viên ở dòng lịch mẫu (GV B có hai khung: nhạt nhất rồi đậm nhất).
    await db
      .update(scheduleTemplates)
      .set({ teacherId: f.teacherB.id })
      .where(and(eq(scheduleTemplates.classId, f.classA.id), eq(scheduleTemplates.weekday, 6)));
    expect(await titles()).toEqual(["Tối Thứ 2|B", "Tối Thứ 5|A", "Sáng Thứ 7|A"]);
    expect(await headers()).toEqual([
      [ROSTER_LIGHTEST, expect.any(Number), 255],
      [0.855, expect.any(Number), 75],
      [ROSTER_DARKEST, expect.any(Number), 255],
    ]);

    // Thêm một buổi của GV B ở cùng lớp A: gom vào khung sẵn có, số khung và màu không đổi.
    await db.insert(scheduleTemplates).values({ classId: f.classA.id, weekday: 7, timeSlotId: evening.id, teacherId: f.teacherB.id });
    expect(await titles()).toEqual(["Tối Thứ 2|B", "Tối Thứ 5|A", "Sáng Thứ 7 + Tối Chủ nhật|A"]);
    const ofB = async () => (await headers()).filter(([, , hue]) => hue === 255).map(([lightness]) => lightness);
    expect(await ofB()).toEqual([ROSTER_LIGHTEST, ROSTER_DARKEST]);

    // Ba khung của cùng một giáo viên (ba lớp) xếp xen kẽ: nhạt nhất, đậm nhất, rồi mức giữa.
    const [third] = await db
      .insert(classes)
      .values({ code: "C", name: "Lớp C", startDate: "2026-01-06", endDate: "2026-03-31", maxSize: 8 })
      .returning();
    await db.insert(scheduleTemplates).values({ classId: third!.id, weekday: 7, timeSlotId: afternoon.id, teacherId: f.teacherB.id });
    expect(await titles()).toEqual(["Tối Thứ 2|B", "Tối Thứ 5|A", "Sáng Thứ 7 + Tối Chủ nhật|A", "Chiều Chủ nhật|C"]);
    expect(await ofB()).toEqual([ROSTER_LIGHTEST, ROSTER_DARKEST, 0.855]);
    await db.delete(classes).where(eq(classes.id, third!.id));

    // Khung chưa có giáo viên (lớp không có GV chính, lịch mẫu không ghi giáo viên): xám trung tính.
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

  it("không gồm lớp đã đóng và lớp chỉ hiển thị trên Thời khóa biểu; lớp chưa có lịch mẫu nằm ở danh sách riêng", async () => {
    await db.update(classes).set({ status: "closed" }).where(eq(classes.id, f.classB.id));
    const [lend, fresh] = await db
      .insert(classes)
      .values([
        { code: "MP", name: "Mượn phòng", courseId: f.course.id, startDate: "2026-01-06", endDate: "2026-03-31", maxSize: 1, timetableOnly: true },
        { code: "M", name: "Lớp mới", courseId: f.course.id, startDate: "2026-01-06", endDate: "2026-03-31", maxSize: 8 },
      ])
      .returning();
    await db.insert(scheduleTemplates).values({ classId: lend!.id, weekday: 2, timeSlotId: evening.id });
    // Lớp mới có buổi xếp tay trên Thời khóa biểu nhưng chưa có lịch mẫu: vẫn nằm ở danh sách riêng.
    await hold({ classId: fresh!.id, date: "2026-01-13" });
    const { blocks, unscheduled } = await roster();
    expect(blocks.map(title)).toEqual(["Tối Thứ 5 + Sáng Thứ 7|A"]);
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
