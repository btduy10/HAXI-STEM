import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attendances, classTeachers, classes, rooms, sessions, teachers, timeSlots } from "@/db/schema";
import { assertClassAccess, assertSessionAccess, type Actor } from "@/server/guard";
import * as classSvc from "@/server/services/classes";
import * as svc from "@/server/services/sessions";
import { type Fixture, resetDb, seedFixture } from "./helpers";

// Lớp A và B: 06/01/2026 → 31/03/2026.
// Khoảng sinh buổi dùng trong test: từ 01/02 đến ngày kết thúc của lớp (9 Thứ Ba: 03/02 … 31/03).
const FROM_FEB = { from: "2026-02-01", to: "2026-03-31" };
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

describe("lịch mẫu chỉ có hiệu lực khi sinh lịch", () => {
  it("thêm lịch mẫu không tự tạo buổi; sinh buổi thì lấy đúng GV chính của lớp và trợ giảng của lịch mẫu, trùng lịch trợ giảng thì bỏ qua", async () => {
    const row = await svc.createTemplate(f.admin, templateInput(f.classA.id, { assistantTeacherId: teacherC.id }));
    expect(row).toMatchObject({ classId: f.classA.id, weekday: 2, assistantTeacherId: teacherC.id });
    expect(await sessionsOf(f.classA.id)).toEqual([]);

    const result = await svc.generateSessions(f.admin, f.classA.id, FROM_FEB);
    const list = await sessionsOf(f.classA.id);
    expect(result.created).toBe(9);
    expect(list.map((s) => s.date)[0]).toBe("2026-02-03");
    expect(list.at(-1)!.date).toBe("2026-03-31");
    expect(list.every((s) => s.teacherId === f.teacherA.id && s.assistantTeacherId === teacherC.id)).toBe(true);

    // Lớp B cùng giờ, khác phòng, nhưng trợ giảng C đang bận ở lớp A → cả 9 buổi trùng bị bỏ qua, không xếp sang tuần sau.
    await svc.createTemplate(f.admin, templateInput(f.classB.id, { roomId: lab2.id, assistantTeacherId: teacherC.id }));
    const clash = await svc.generateSessions(f.admin, f.classB.id, FROM_FEB);
    expect(clash.conflicts).toHaveLength(9);
    expect(await sessionsOf(f.classB.id)).toEqual([]);
    expect(clash.conflicts[0]!.reason).toContain("Giáo viên đã có buổi A");
  });

  it("sửa, đổi thứ hoặc xóa dòng lịch mẫu không làm đổi buổi nào đã có trên Thời khóa biểu", async () => {
    const tpl = await svc.createTemplate(f.admin, templateInput(f.classA.id));
    await svc.generateSessions(f.admin, f.classA.id, FROM_FEB);
    const before = await sessionsOf(f.classA.id);
    expect(before).toHaveLength(9);
    const [attended] = before;
    await db.insert(attendances).values({ sessionId: attended!.id, studentId: f.students[0]!.id, status: "present" });

    // Đổi ca, thêm trợ giảng.
    const changed = await svc.updateTemplate(f.admin, { ...templateInput(f.classA.id), id: tpl.id, timeSlotId: late.id, assistantTeacherId: teacherC.id });
    expect(changed).toMatchObject({ timeSlotId: late.id, assistantTeacherId: teacherC.id });
    expect(await sessionsOf(f.classA.id)).toEqual(before);
    // Đổi sang Thứ Năm.
    await svc.updateTemplate(f.admin, { ...templateInput(f.classA.id), id: tpl.id, weekday: 4, timeSlotId: late.id });
    expect(await sessionsOf(f.classA.id)).toEqual(before);
    // Thêm dòng thứ hai.
    await svc.createTemplate(f.admin, templateInput(f.classA.id, { weekday: 6 }));
    expect(await sessionsOf(f.classA.id)).toEqual(before);
    // Xóa dòng lịch mẫu: buổi vẫn còn, chỉ thôi gắn với dòng đó.
    await svc.deleteTemplate(f.admin, tpl.id);
    const after = await sessionsOf(f.classA.id);
    expect(after.map((s) => [s.id, s.date, s.startTime, s.teacherId])).toEqual(before.map((s) => [s.id, s.date, s.startTime, s.teacherId]));
    expect(after.every((s) => s.templateId === null)).toBe(true);

    await expect(svc.updateTemplate(f.actorA, { ...templateInput(f.classA.id), id: tpl.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("trợ giảng phải khác GV chính; sửa từng buổi đổi được GV chính và trợ giảng", async () => {
    await expect(svc.createTemplate(f.admin, templateInput(f.classA.id, { teacherId: f.teacherA.id, assistantTeacherId: f.teacherA.id }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await svc.createTemplate(f.admin, templateInput(f.classA.id));
    await svc.generateSessions(f.admin, f.classA.id, FROM_FEB);
    const [first] = await sessionsOf(f.classA.id);
    const edit = { id: first!.id, startTime: "08:00", endTime: "09:30", roomId: f.room.id, content: null, note: null };
    await expect(svc.updateSession(f.admin, { ...edit, teacherId: f.teacherA.id, assistantTeacherId: f.teacherA.id })).rejects.toMatchObject({ code: "VALIDATION" });
    await svc.updateSession(f.admin, { ...edit, teacherId: f.teacherB.id, assistantTeacherId: teacherC.id });
    expect((await sessionsOf(f.classA.id))[0]).toMatchObject({ teacherId: f.teacherB.id, assistantTeacherId: teacherC.id });
    await svc.updateSession(f.admin, { ...edit, teacherId: f.teacherB.id, assistantTeacherId: null });
    expect((await sessionsOf(f.classA.id))[0]!.assistantTeacherId).toBeNull();
  });
});

describe("sinh buổi theo khoảng ngày (dữ liệu mẫu)", () => {
  it("chỉ sinh trong phần giao của khoảng ngày với thời gian học của lớp; không có khoảng thì cả thời gian của lớp; chạy lại không tạo thêm", async () => {
    await svc.createTemplate(f.admin, templateInput(f.classA.id));
    await svc.createTemplate(f.admin, templateInput(f.classA.id, { weekday: 4 }));
    // 01/02 – 14/02: Thứ Ba 03/02, 10/02 và Thứ Năm 05/02, 12/02.
    const part = await svc.generateSessions(f.admin, f.classA.id, { from: "2026-02-01", to: "2026-02-14" });
    expect(part.created).toBe(4);
    expect((await sessionsOf(f.classA.id)).map((s) => s.date)).toEqual(["2026-02-03", "2026-02-05", "2026-02-10", "2026-02-12"]);
    // Khoảng vượt ngày kết thúc của lớp (31/03): không xếp quá ngày kết thúc.
    await svc.generateSessions(f.admin, f.classA.id, { from: "2026-03-25", to: "2026-04-30" });
    expect((await sessionsOf(f.classA.id)).at(-1)!.date).toBe("2026-03-31");
    // Không có khoảng: cả thời gian của lớp, buổi đầu vào ngày khai giảng 06/01; chạy lại không tạo thêm, ngày kết thúc không đổi.
    await svc.generateSessions(f.admin, f.classA.id);
    const all = await sessionsOf(f.classA.id);
    expect(all[0]!.date).toBe("2026-01-06");
    expect(all).toHaveLength(25); // 13 Thứ Ba (06/01 … 31/03) + 12 Thứ Năm (08/01 … 26/03)
    expect((await svc.generateSessions(f.admin, f.classA.id)).created).toBe(0);
    expect((await db.select().from(classes).where(eq(classes.id, f.classA.id)))[0]!.endDate).toBe("2026-03-31");
  });
});

describe("trợ giảng và phân công", () => {
  it("trợ giảng được xếp vào buổi của lớp khác thì thấy lớp đó, vào được buổi và có buổi trong TKB của mình", async () => {
    // C chỉ được phân công ở lớp A; lớp B chưa liên quan.
    await svc.createTemplate(f.admin, templateInput(f.classB.id));
    await svc.generateSessions(f.admin, f.classB.id, FROM_FEB);
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
