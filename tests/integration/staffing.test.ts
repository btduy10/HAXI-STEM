import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attendances, classTeachers, classes, rooms, scheduleTemplates, sessions, teachers, timeSlots } from "@/db/schema";
import { assertClassAccess, assertSessionAccess, type Actor } from "@/server/guard";
import * as classSvc from "@/server/services/classes";
import * as svc from "@/server/services/sessions";
import { type Fixture, resetDb, seedFixture } from "./helpers";

// Lớp A và B: 05/01/2026 → 31/03/2026. "Hôm nay" là Chủ nhật 01/02/2026.
const now = new Date("2026-02-01T05:00:00Z");
let f: Fixture;
let morning: typeof timeSlots.$inferSelect;
let late: typeof timeSlots.$inferSelect;
let teacherC: typeof teachers.$inferSelect;
let actorC: Actor;
let lab2: typeof rooms.$inferSelect;

beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  [morning, late] = (await db
    .insert(timeSlots)
    .values([
      { name: "Ca sáng", frame: 1, defaultStart: "08:00", defaultEnd: "09:30" },
      { name: "Ca muộn", frame: 1, defaultStart: "10:00", defaultEnd: "11:30" },
    ])
    .returning()) as [typeof timeSlots.$inferSelect, typeof timeSlots.$inferSelect];
  [teacherC] = (await db.insert(teachers).values({ code: "GVC", fullName: "Trợ giảng C" }).returning()) as [typeof teachers.$inferSelect];
  [lab2] = (await db.insert(rooms).values({ name: "Lab 2", capacity: 10 }).returning()) as [typeof rooms.$inferSelect];
  await db.insert(classTeachers).values({ classId: f.classA.id, teacherId: teacherC.id, role: "assistant" });
  actorC = { userId: f.admin.userId, role: "teacher", teacherId: teacherC.id };
});

const sessionsOf = (classId: string) =>
  db.select().from(sessions).where(eq(sessions.classId, classId)).orderBy(asc(sessions.date), asc(sessions.startTime));
const templateInput = (classId: string, extra: Partial<Parameters<typeof svc.createTemplate>[1]> = {}) => ({
  classId,
  weekday: 2,
  timeSlotId: morning.id,
  roomId: null,
  teacherId: null,
  assistantTeacherId: null,
  startTime: null,
  endTime: null,
  ...extra,
});

describe("lịch mẫu tự sinh và tự cập nhật thời khóa biểu", () => {
  it("thêm lịch mẫu là tự có buổi từ hôm nay đến ngày kết thúc của lớp, kèm trợ giảng; trùng lịch trợ giảng thì bỏ qua và báo lại", async () => {
    const result = await svc.createTemplate(f.admin, templateInput(f.classA.id, { assistantTeacherId: teacherC.id }), now);
    const list = await sessionsOf(f.classA.id);
    // Xếp từ hôm nay đến ngày kết thúc của lớp: Thứ Ba 03/02 → 31/03 là 9 buổi; không xếp quá ngày kết thúc.
    expect(result.created).toBe(9);
    expect(list.at(-1)!.date).toBe("2026-03-31");
    expect(list.map((s) => s.date)[0]).toBe("2026-02-03");
    expect(list.every((s) => s.teacherId === f.teacherA.id && s.assistantTeacherId === teacherC.id)).toBe(true);
    expect(result.notices).toEqual(["Đã tự thêm 9 buổi vào Thời khóa biểu."]);

    // Lớp B cùng giờ, khác phòng, nhưng trợ giảng C đang bận ở lớp A → cả 9 buổi trùng bị bỏ qua, không xếp sang tuần sau.
    const clash = await svc.createTemplate(f.admin, templateInput(f.classB.id, { roomId: lab2.id, assistantTeacherId: teacherC.id }), now);
    expect(clash.conflicts).toHaveLength(9);
    expect(await sessionsOf(f.classB.id)).toEqual([]);
    expect(clash.warnings.join(" ")).toContain("Giáo viên đã có buổi A");
  });

  it("sửa lịch mẫu cập nhật buổi sắp tới; giữ buổi đã điểm danh và phần đã sửa tay; đổi thứ thì sinh lại", async () => {
    await svc.createTemplate(f.admin, templateInput(f.classA.id), now);
    const [tpl] = await db.select().from(scheduleTemplates).where(eq(scheduleTemplates.classId, f.classA.id));
    const [attended, edited] = await sessionsOf(f.classA.id);
    await db.insert(attendances).values({ sessionId: attended!.id, studentId: f.students[0]!.id, status: "present" });
    await db.update(sessions).set({ roomId: lab2.id }).where(eq(sessions.id, edited!.id)); // sửa tay phòng của buổi 10/02

    const result = await svc.updateTemplate(f.admin, { ...templateInput(f.classA.id), id: tpl!.id, timeSlotId: late.id, assistantTeacherId: teacherC.id }, now);
    // 9 buổi (03/02 → 31/03), trừ 1 buổi đã điểm danh.
    expect(result.updated).toBe(8);
    const after = await sessionsOf(f.classA.id);
    expect(after.find((s) => s.id === attended!.id)).toMatchObject({ startTime: "08:00:00", assistantTeacherId: null });
    expect(after.find((s) => s.id === edited!.id)).toMatchObject({ startTime: "10:00:00", roomId: lab2.id, assistantTeacherId: teacherC.id });
    expect(after.filter((s) => s.startTime === "10:00:00" && s.roomId === f.room.id)).toHaveLength(7);

    // Đổi sang Thứ Năm: buổi chưa điểm danh được sinh lại vào Thứ Năm; buổi đã điểm danh giữ nguyên.
    const moved = await svc.updateTemplate(f.admin, { ...templateInput(f.classA.id), id: tpl!.id, weekday: 4, timeSlotId: late.id }, now);
    expect(moved.created).toBe(8); // 1 buổi đã dạy + 8 Thứ Năm 05/02 … 26/03
    const days = (await sessionsOf(f.classA.id)).map((s) => s.date);
    expect(days).toContain(attended!.date);
    expect(days.filter((d) => d !== attended!.date).every((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 4)).toBe(true);
  });

  it("trợ giảng phải khác GV chính; sửa từng buổi đổi được GV chính và trợ giảng", async () => {
    await expect(svc.createTemplate(f.admin, templateInput(f.classA.id, { teacherId: f.teacherA.id, assistantTeacherId: f.teacherA.id }), now)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await svc.createTemplate(f.admin, templateInput(f.classA.id), now);
    const [first] = await sessionsOf(f.classA.id);
    const edit = { id: first!.id, startTime: "08:00", endTime: "09:30", roomId: f.room.id, content: null, note: null };
    await expect(svc.updateSession(f.admin, { ...edit, teacherId: f.teacherA.id, assistantTeacherId: f.teacherA.id })).rejects.toMatchObject({ code: "VALIDATION" });
    await svc.updateSession(f.admin, { ...edit, teacherId: f.teacherB.id, assistantTeacherId: teacherC.id });
    expect((await sessionsOf(f.classA.id))[0]).toMatchObject({ teacherId: f.teacherB.id, assistantTeacherId: teacherC.id });
    await svc.updateSession(f.admin, { ...edit, teacherId: f.teacherB.id, assistantTeacherId: null });
    expect((await sessionsOf(f.classA.id))[0]!.assistantTeacherId).toBeNull();
  });
});

describe("số buổi theo thời gian của lớp", () => {
  it("xếp buổi cho mọi tuần đến ngày kết thúc của lớp, không giới hạn theo khóa học; thêm lịch mẫu thứ hai thì có thêm buổi của thứ đó", async () => {
    // Lớp A học đến 31/03; hôm nay 01/02. Khóa học khai 10 buổi không còn là giới hạn của lớp.
    const first = await svc.createTemplate(f.admin, templateInput(f.classA.id), now);
    expect(first.created).toBe(9); // 9 Thứ Ba từ 03/02 đến 31/03
    expect(first.scheduled).toBe(9);
    expect(first).not.toHaveProperty("courseSessions");
    await svc.createTemplate(f.admin, templateInput(f.classA.id, { weekday: 4 }), now);
    const list = await sessionsOf(f.classA.id);
    // 9 Thứ Ba + 8 Thứ Năm (05/02 … 26/03), theo thứ tự ngày.
    expect(list).toHaveLength(17);
    expect(list.map((s) => s.date).slice(0, 4)).toEqual(["2026-02-03", "2026-02-05", "2026-02-10", "2026-02-12"]);
    expect(list.at(-1)!.date).toBe("2026-03-31");
    // Bấm "Sinh buổi" xếp cho cả thời gian của lớp: bổ sung 8 buổi của các tuần trước hôm nay (06/01 … 29/01);
    // bấm lại không tạo thêm; ngày kết thúc của lớp không đổi.
    expect((await svc.generateSessions(f.admin, f.classA.id)).created).toBe(8);
    expect((await sessionsOf(f.classA.id))[0]!.date).toBe("2026-01-06");
    expect((await svc.generateSessions(f.admin, f.classA.id)).created).toBe(0);
    expect((await db.select().from(classes).where(eq(classes.id, f.classA.id)))[0]!.endDate).toBe("2026-03-31");
  });
});

describe("trợ giảng và phân công", () => {
  it("trợ giảng được xếp vào buổi của lớp khác thì thấy lớp đó, vào được buổi và có buổi trong TKB của mình", async () => {
    // C chỉ được phân công ở lớp A; lớp B chưa liên quan.
    await svc.createTemplate(f.admin, templateInput(f.classB.id), now);
    await expect(assertClassAccess(actorC, f.classB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [first] = await sessionsOf(f.classB.id);
    await expect(assertSessionAccess(actorC, first!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    await db.update(sessions).set({ assistantTeacherId: teacherC.id }).where(eq(sessions.id, first!.id));
    await expect(assertClassAccess(actorC, f.classB.id)).resolves.toBeUndefined();
    await expect(assertSessionAccess(actorC, first!.id)).resolves.toBeUndefined();
    const mine = await svc.listSessions(actorC, { from: "2026-02-01", to: "2026-02-08", personal: true });
    expect(mine.map((s) => [s.date, s.classCode, s.assistantName])).toEqual([["2026-02-03", "B", "Trợ giảng C"]]);

    // Tên viết tắt của giáo viên đi kèm buổi học để Thời khóa biểu hiển thị cho gọn; chưa đặt thì null.
    expect(mine.map((s) => [s.teacherShortName, s.assistantShortName])).toEqual([[null, null]]);
    await db.update(teachers).set({ shortName: "C." }).where(eq(teachers.id, teacherC.id));
    await db.update(teachers).set({ shortName: "Cô B" }).where(eq(teachers.id, f.teacherB.id));
    const [again] = await svc.listSessions(actorC, { from: "2026-02-01", to: "2026-02-08", personal: true });
    expect(again).toMatchObject({ teacherName: "Giáo viên B", teacherShortName: "Cô B", assistantName: "Trợ giảng C", assistantShortName: "C.", substituteShortName: null });
  });

  it("sửa vai trò của phân công; phân công không còn mang lương (đặt ở Chấm công → Mức lương)", async () => {
    const [row] = await db
      .select()
      .from(classTeachers)
      .where(and(eq(classTeachers.classId, f.classA.id), eq(classTeachers.teacherId, f.teacherA.id)));
    await classSvc.updateClassTeacher(f.admin, { id: row!.id, role: "assistant" });
    const asAdmin = await classSvc.listClassTeachers(f.admin, f.classA.id);
    expect(asAdmin.map((t) => [t.code, t.role])).toEqual([
      ["GVA", "assistant"],
      ["GVC", "assistant"],
    ]);
    expect(Object.keys(asAdmin[0]!)).not.toContain("ratePerSession");
    await expect(classSvc.updateClassTeacher(f.actorA, { id: row!.id, role: "main" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
