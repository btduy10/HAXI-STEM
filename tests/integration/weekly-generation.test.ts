import { and, asc, between, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { GET as cronRoute } from "@/app/api/cron/generate-sessions/route";
import { attendances, auditLogs, classes, holidays, makeupAssignments, rooms, scheduleTemplates, sessions, starLogs, teachers, timeSlots } from "@/db/schema";
import { DEFAULT_PERMISSIONS, type RolePermissions } from "@/lib/permissions";
import type { Actor } from "@/server/guard";
import * as classSvc from "@/server/services/classes";
import * as svc from "@/server/services/sessions";
import { type Fixture, resetDb, seedFixture } from "./helpers";

// Lớp A và B: 06/01/2026 (Thứ Ba) → 31/03/2026 (Thứ Ba), chung phòng "Lab"; GV chính A và B.
// "Hôm nay" là Thứ Tư 04/02/2026: tuần này 02/02 – 08/02, TUẦN SAU 09/02 – 15/02.
// Lịch mẫu và tác vụ hằng ngày sinh buổi trong khoảng HÔM NAY → HẾT TUẦN SAU: 04/02 – 15/02.
const now = new Date("2026-02-04T05:00:00Z");
const WEEK = { from: "2026-02-09", to: "2026-02-15" };
const RANGE = { from: "2026-02-04", to: "2026-02-15" };
let f: Fixture;
let morning: typeof timeSlots.$inferSelect;
let evening: typeof timeSlots.$inferSelect;

beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  [morning, evening] = (await db
    .insert(timeSlots)
    .values([
      { name: "Ca sáng", frame: 1, defaultStart: "08:00", defaultEnd: "09:30" },
      { name: "Ca tối", frame: 1, defaultStart: "18:00", defaultEnd: "19:30" },
    ])
    .returning()) as [typeof timeSlots.$inferSelect, typeof timeSlots.$inferSelect];
});

const template = (classId: string, weekday: number, slotId: string, extra: Partial<typeof scheduleTemplates.$inferInsert> = {}) =>
  db.insert(scheduleTemplates).values({ classId, weekday, timeSlotId: slotId, ...extra }).returning();
const sessionsOf = (classId: string) =>
  db.select().from(sessions).where(eq(sessions.classId, classId)).orderBy(asc(sessions.date), asc(sessions.startTime));
const inWeek = (classId: string) =>
  db
    .select()
    .from(sessions)
    .where(and(eq(sessions.classId, classId), between(sessions.date, WEEK.from, WEEK.to)))
    .orderBy(asc(sessions.date), asc(sessions.startTime));
const upcoming = (classId: string) =>
  db
    .select()
    .from(sessions)
    .where(and(eq(sessions.classId, classId), between(sessions.date, RANGE.from, RANGE.to)))
    .orderBy(asc(sessions.date), asc(sessions.startTime));
const templatesOf = (classId: string) =>
  db.select().from(scheduleTemplates).where(eq(scheduleTemplates.classId, classId)).orderBy(asc(scheduleTemplates.weekday));
/** Dữ liệu form của một dòng lịch mẫu: mặc định Thứ Tư, ca sáng, GV A. */
const fields = (extra: Partial<Omit<Parameters<typeof svc.createTemplate>[1], "classId">> = {}) => ({
  weekday: 3,
  timeSlotId: morning.id,
  teacherId: f.teacherA.id as string | null,
  assistantTeacherId: null as string | null,
  startTime: null,
  endTime: null,
  ...extra,
});
const staff = async (classId: string) => (await classSvc.listClassTeachers(f.admin, classId)).map((t) => [t.code, t.role]);
const hold = async (values: Partial<typeof sessions.$inferInsert> & { classId: string; date: string }) =>
  (await db.insert(sessions).values({ startTime: "08:00", endTime: "09:30", timeSlotId: morning.id, ...values }).returning())[0]!;
const withMenus = (actor: Actor, scope: RolePermissions["scope"], menus: Partial<RolePermissions["menus"]>): Actor => ({
  ...actor,
  perms: { scope, menus: { ...DEFAULT_PERMISSIONS.teacher.menus, ...menus } },
});
const FULL = { view: true, add: true, edit: true };

describe("lịch mẫu tự xếp buổi từ hôm nay đến hết tuần sau", () => {
  it("thêm dòng: có buổi từ hôm nay đến hết tuần sau, phòng của lớp, bỏ ngày nghỉ; ngoài khoảng không đụng; giáo viên của lớp ghi theo lịch mẫu", async () => {
    const [teacherC] = await db.insert(teachers).values({ code: "GVC", fullName: "GV C" }).returning();
    // Buổi đã có ngoài khoảng (hôm qua và sau tuần sau): không bị đụng, không được sinh thêm.
    const past = await hold({ classId: f.classA.id, date: "2026-02-03" });
    const far = await hold({ classId: f.classA.id, date: "2026-02-18" });

    const added = await svc.createTemplate(f.admin, { classId: f.classA.id, ...fields({ assistantTeacherId: teacherC!.id }) }, now);
    // Thứ Tư: hôm nay 04/02 và 11/02.
    expect(added).toEqual({ created: 2, removed: 0, notices: ["Đã thêm 2 buổi vào Thời khóa biểu."], warnings: [] });
    const [tpl] = await templatesOf(f.classA.id);
    expect(tpl).toMatchObject({ roomId: null, teacherId: f.teacherA.id, assistantTeacherId: teacherC!.id });
    expect((await upcoming(f.classA.id)).map((s) => [s.date, s.startTime, s.teacherId, s.assistantTeacherId, s.roomId, s.templateId, s.status])).toEqual([
      ["2026-02-04", "08:00:00", f.teacherA.id, teacherC!.id, f.room.id, tpl!.id, "planned"],
      ["2026-02-11", "08:00:00", f.teacherA.id, teacherC!.id, f.room.id, tpl!.id, "planned"],
    ]);
    expect((await sessionsOf(f.classA.id)).map((s) => s.date)).toEqual(["2026-02-03", "2026-02-04", "2026-02-11", "2026-02-18"]);

    // Dòng Thứ Ba ca tối: 03/02 đã qua nên chỉ có 10/02. Dòng Thứ Năm với 12/02 là ngày nghỉ: chỉ có 05/02.
    expect(await svc.createTemplate(f.admin, { classId: f.classA.id, ...fields({ weekday: 2, timeSlotId: evening.id }) }, now)).toMatchObject({ created: 1 });
    await db.insert(holidays).values({ date: "2026-02-12", reason: "Nghỉ" });
    expect(await svc.createTemplate(f.admin, { classId: f.classA.id, ...fields({ weekday: 4, teacherId: f.teacherB.id }) }, now)).toMatchObject({ created: 1 });
    expect((await upcoming(f.classA.id)).map((s) => s.date)).toEqual(["2026-02-04", "2026-02-05", "2026-02-10", "2026-02-11"]);
    expect((await sessionsOf(f.classA.id)).map((s) => s.id)).toEqual(expect.arrayContaining([past.id, far.id]));
    expect(await sessionsOf(f.classA.id)).toHaveLength(6);

    // Không còn mục phân công riêng: giáo viên của lớp là GV chính và trợ giảng của các dòng lịch mẫu.
    expect(await staff(f.classA.id)).toEqual([
      ["GVA", "main"],
      ["GVB", "main"],
      ["GVC", "assistant"],
    ]);
  });

  it("trùng lịch thì bỏ qua và báo; GV chính bắt buộc trừ lớp chỉ hiển thị trên Thời khóa biểu; lớp đóng, ngoài thời gian học, thiếu quyền thì không sinh", async () => {
    await svc.createTemplate(f.admin, { classId: f.classA.id, ...fields() }, now);
    // Lớp B cùng Thứ Tư ca sáng, cùng phòng Lab: cả hai buổi bị bỏ qua, dòng lịch mẫu vẫn được lưu.
    const clash = await svc.createTemplate(f.admin, { classId: f.classB.id, ...fields({ teacherId: f.teacherB.id }) }, now);
    expect(clash).toMatchObject({ created: 0, removed: 0, notices: [] });
    expect(clash.warnings).toHaveLength(2);
    expect(clash.warnings[0]).toMatch(/^Bỏ qua buổi 04\/02\/2026 08:00: .*Phòng/);
    expect(await sessionsOf(f.classB.id)).toEqual([]);
    expect(await templatesOf(f.classB.id)).toHaveLength(1);

    // Lớp thường: thiếu giáo viên chính thì từ chối.
    await expect(svc.createTemplate(f.admin, { classId: f.classA.id, ...fields({ weekday: 5, teacherId: null }) }, now)).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { teacherId: "Bắt buộc chọn" },
    });
    expect(await templatesOf(f.classA.id)).toHaveLength(1);
    // Lớp chỉ hiển thị trên Thời khóa biểu (cho mượn phòng): không cần giáo viên.
    const [lab2] = await db.insert(rooms).values({ name: "Lab 2", capacity: 10 }).returning();
    const [lend] = await db
      .insert(classes)
      .values({ code: "MP", name: "Mượn phòng", startDate: "2026-01-06", endDate: "2026-03-31", maxSize: 1, timetableOnly: true, defaultRoomId: lab2!.id })
      .returning();
    expect(await svc.createTemplate(f.admin, { classId: lend!.id, ...fields({ weekday: 5, timeSlotId: evening.id, teacherId: null }) }, now)).toMatchObject({ created: 2 });
    expect((await sessionsOf(lend!.id)).map((s) => [s.date, s.teacherId, s.roomId])).toEqual([
      ["2026-02-06", null, lab2!.id],
      ["2026-02-13", null, lab2!.id],
    ]);

    // Quyền: cần quyền Sửa của Lớp học và lớp trong phạm vi.
    await expect(svc.createTemplate(f.actorA, { classId: f.classA.id, ...fields({ weekday: 6 }) }, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const editor = withMenus(f.actorA, "own", { classes: FULL });
    await expect(svc.createTemplate(editor, { classId: f.classB.id, ...fields({ weekday: 6 }) }, now)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Hôm nay đã qua ngày kết thúc của lớp (31/03), hoặc lớp đã đóng: lưu dòng lịch mẫu nhưng không sinh buổi.
    expect(await svc.createTemplate(f.admin, { classId: f.classA.id, ...fields({ weekday: 6 }) }, new Date("2026-04-10T05:00:00Z"))).toMatchObject({ created: 0, notices: [] });
    await db.update(classes).set({ status: "closed" }).where(eq(classes.id, f.classB.id));
    expect(await svc.createTemplate(f.admin, { classId: f.classB.id, ...fields({ weekday: 7, teacherId: f.teacherB.id }) }, now)).toMatchObject({ created: 0 });
    expect(await sessionsOf(f.classB.id)).toEqual([]);
  });

  it("sửa dòng: buổi chưa dạy của dòng đó đổi theo; giữ buổi đã điểm danh, buổi sửa tay và buổi ngoài khoảng; đổi thứ thì xếp sang thứ mới", async () => {
    const [teacherC] = await db.insert(teachers).values({ code: "GVC", fullName: "GV C" }).returning();
    const [lab2] = await db.insert(rooms).values({ name: "Lab 2", capacity: 10 }).returning();
    await svc.createTemplate(f.admin, { classId: f.classA.id, ...fields() }, now); // Thứ Tư: 04/02, 11/02
    await svc.createTemplate(f.admin, { classId: f.classA.id, ...fields({ weekday: 5 }) }, now); // Thứ Sáu: 06/02, 13/02
    const [wed, fri] = await templatesOf(f.classA.id);
    const far = await hold({ classId: f.classA.id, date: "2026-02-18", templateId: wed!.id, teacherId: f.teacherA.id, roomId: f.room.id });
    const [w1, f1, w2, f2] = await upcoming(f.classA.id);
    await db.insert(attendances).values({ sessionId: w1!.id, studentId: f.students[0]!.id, status: "present" });
    await db.update(sessions).set({ roomId: lab2!.id }).where(eq(sessions.id, f1!.id)); // sửa tay phòng của buổi 06/02

    // Dòng Thứ Tư đổi sang ca tối, thêm trợ giảng: chỉ buổi 11/02 đổi theo.
    const changed = await svc.updateTemplate(f.admin, { id: wed!.id, ...fields({ timeSlotId: evening.id, assistantTeacherId: teacherC!.id }) }, now);
    expect(changed).toEqual({ created: 1, removed: 1, notices: ["Đã xếp lại 1 buổi sắp tới theo lịch mẫu."], warnings: [] });
    let list = await sessionsOf(f.classA.id);
    expect(list.find((s) => s.id === w1!.id)).toMatchObject({ startTime: "08:00:00", assistantTeacherId: null });
    expect(list.find((s) => s.id === far.id)).toMatchObject({ startTime: "08:00:00", date: "2026-02-18" });
    expect(list.map((s) => s.id)).not.toContain(w2!.id);
    expect(list.find((s) => s.date === "2026-02-11")).toMatchObject({ startTime: "18:00:00", timeSlotId: evening.id, assistantTeacherId: teacherC!.id, templateId: wed!.id });

    // Dòng Thứ Sáu đổi sang Thứ Bảy, GV B: buổi 13/02 chưa dạy bị bỏ, có buổi 07/02 và 14/02; buổi 06/02 đã sửa tay ở lại.
    const moved = await svc.updateTemplate(f.admin, { id: fri!.id, ...fields({ weekday: 6, teacherId: f.teacherB.id }) }, now);
    expect(moved).toMatchObject({ created: 2, removed: 1, notices: ["Đã xếp lại buổi sắp tới theo lịch mẫu: bỏ 1 buổi, thêm 2 buổi."] });
    list = await upcoming(f.classA.id);
    expect(list.map((s) => [s.date, s.teacherId])).toEqual([
      ["2026-02-04", f.teacherA.id],
      ["2026-02-06", f.teacherA.id],
      ["2026-02-07", f.teacherB.id],
      ["2026-02-11", f.teacherA.id],
      ["2026-02-14", f.teacherB.id],
    ]);
    expect(list.map((s) => s.id)).toContain(f1!.id);
    expect(list.map((s) => s.id)).not.toContain(f2!.id);

    // Lưu lại đúng như cũ: không buổi nào bị đụng.
    expect(await svc.updateTemplate(f.admin, { id: fri!.id, ...fields({ weekday: 6, teacherId: f.teacherB.id }) }, now)).toEqual({
      created: 0,
      removed: 0,
      notices: [],
      warnings: [],
    });
    expect(await staff(f.classA.id)).toEqual([
      ["GVA", "main"],
      ["GVB", "main"],
      ["GVC", "assistant"],
    ]);
    await expect(svc.updateTemplate(f.actorA, { id: wed!.id, ...fields() }, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("xóa dòng: bỏ buổi chưa dạy của dòng đó trong khoảng; buổi đã điểm danh, đã hủy, đã dời và buổi ngoài khoảng ở lại", async () => {
    await svc.createTemplate(f.admin, { classId: f.classA.id, ...fields() }, now); // Thứ Tư: 04/02, 11/02
    await svc.createTemplate(f.admin, { classId: f.classA.id, ...fields({ weekday: 4 }) }, now); // Thứ Năm: 05/02, 12/02
    const [wed, thu] = await templatesOf(f.classA.id);
    const [w1, t1, w2, t2] = await upcoming(f.classA.id);
    await db.insert(attendances).values({ sessionId: w1!.id, studentId: f.students[0]!.id, status: "present" });
    await db.update(sessions).set({ status: "cancelled" }).where(eq(sessions.id, t1!.id));
    await db.update(sessions).set({ date: "2026-02-14", originalDate: "2026-02-12" }).where(eq(sessions.id, t2!.id));
    const far = await hold({ classId: f.classA.id, date: "2026-02-18", templateId: wed!.id, teacherId: f.teacherA.id, roomId: f.room.id });

    expect(await svc.deleteTemplate(f.admin, wed!.id, now)).toEqual({ created: 0, removed: 1, notices: ["Đã bỏ 1 buổi chưa dạy khỏi Thời khóa biểu."], warnings: [] });
    let ids = (await sessionsOf(f.classA.id)).map((s) => s.id);
    expect(ids).not.toContain(w2!.id);
    expect(ids).toEqual(expect.arrayContaining([w1!.id, far.id, t1!.id, t2!.id]));
    expect((await sessionsOf(f.classA.id)).find((s) => s.id === w1!.id)!.templateId).toBeNull();

    // Dòng Thứ Năm: một buổi đã hủy, một buổi đã dời → không buổi nào bị bỏ.
    expect(await svc.deleteTemplate(f.admin, thu!.id, now)).toEqual({ created: 0, removed: 0, notices: [], warnings: [] });
    ids = (await sessionsOf(f.classA.id)).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([t1!.id, t2!.id]));
    expect(await templatesOf(f.classA.id)).toEqual([]);

    // Dòng Thứ Sáu (06/02, 13/02): một buổi đã ghi sao, một buổi đã có em lớp B được xếp học bù vào → cũng ở lại.
    await svc.createTemplate(f.admin, { classId: f.classA.id, ...fields({ weekday: 5 }) }, now);
    const [fri] = await templatesOf(f.classA.id);
    const [s1, s2] = (await upcoming(f.classA.id)).filter((s) => s.templateId === fri!.id);
    await db.insert(starLogs).values({ sessionId: s1!.id, studentId: f.students[0]!.id, stars: 2 });
    const absent = await hold({ classId: f.classB.id, date: "2026-02-03", status: "done", startTime: "10:00", endTime: "11:30", timeSlotId: null });
    await db.insert(makeupAssignments).values({ absentSessionId: absent.id, makeupSessionId: s2!.id, studentId: f.students[2]!.id });
    expect(await svc.deleteTemplate(f.admin, fri!.id, now)).toMatchObject({ removed: 0 });
    expect((await sessionsOf(f.classA.id)).map((s) => s.id)).toEqual(expect.arrayContaining([s1!.id, s2!.id]));
    expect(await db.select().from(makeupAssignments)).toHaveLength(1);
    // Hết lịch mẫu thì lớp không còn giáo viên được ghi theo lịch mẫu.
    expect(await staff(f.classA.id)).toEqual([]);

    await svc.createTemplate(f.admin, { classId: f.classA.id, ...fields() }, now);
    const [again] = await templatesOf(f.classA.id);
    await expect(svc.deleteTemplate(f.actorA, again!.id, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("nút Sinh lịch tuần sau ở Thời khóa biểu", () => {
  it("bổ sung buổi còn thiếu của tuần sau cho mọi lớp đang mở có lịch mẫu; buổi đã có giữ nguyên, bấm lại không tạo trùng", async () => {
    const [lab2] = await db.insert(rooms).values({ name: "Lab 2", capacity: 10 }).returning();
    const [tplA] = await template(f.classA.id, 2, morning.id);
    await template(f.classB.id, 4, morning.id);
    const [closed, bare, lend] = await db
      .insert(classes)
      .values([
        { code: "D", name: "Lớp đã đóng", startDate: "2026-01-06", endDate: "2026-03-31", maxSize: 8, status: "closed" },
        { code: "E", name: "Lớp chưa có lịch mẫu", startDate: "2026-01-06", endDate: "2026-03-31", maxSize: 8 },
        { code: "MP", name: "Mượn phòng", startDate: "2026-01-06", endDate: "2026-03-31", maxSize: 1, timetableOnly: true, defaultRoomId: lab2!.id },
      ])
      .returning();
    await template(closed!.id, 5, morning.id);
    await template(lend!.id, 5, evening.id);
    // Buổi Thứ Ba tuần sau của lớp A đã có và đã sửa tay giờ, phòng: không bị đụng.
    const edited = await hold({ classId: f.classA.id, date: "2026-02-10", templateId: tplA!.id, startTime: "09:00", endTime: "10:30", timeSlotId: null, roomId: lab2!.id });
    // Buổi ở tuần khác cũng không bị đụng và không được sinh thêm.
    const other = await hold({ classId: f.classB.id, date: "2026-02-19" });

    const result = await svc.generateNextWeekForAll(f.admin, now);
    // Lớp B (Thứ Năm 12/02) và lớp mượn phòng (Thứ Sáu 13/02); lớp A đã đủ.
    expect(result).toEqual({ week: WEEK, created: 2, alreadyExisting: 1, warnings: [], classCount: 3 });
    expect((await inWeek(f.classB.id)).map((s) => [s.date, s.teacherId])).toEqual([["2026-02-12", f.teacherB.id]]);
    expect((await inWeek(lend!.id)).map((s) => s.date)).toEqual(["2026-02-13"]);
    expect(await inWeek(f.classA.id)).toEqual([edited]);
    expect((await sessionsOf(f.classB.id)).map((s) => s.id)).toContain(other.id);
    expect(await sessionsOf(f.classB.id)).toHaveLength(2);
    expect(await sessionsOf(closed!.id)).toEqual([]);
    expect(await sessionsOf(bare!.id)).toEqual([]);

    expect(await svc.generateNextWeekForAll(f.admin, now)).toMatchObject({ created: 0, alreadyExisting: 3 });
    expect(await inWeek(f.classB.id)).toHaveLength(1);
  });

  it("báo buổi bị trùng kèm mã lớp và lớp nằm ngoài thời gian học", async () => {
    // Lớp A và B cùng Thứ Ba ca sáng, cùng phòng Lab: lớp A (mã đứng trước) được xếp, lớp B bị bỏ qua.
    await template(f.classA.id, 2, morning.id);
    await template(f.classB.id, 2, morning.id);
    const [ended] = await db
      .insert(classes)
      .values({ code: "Z", name: "Lớp đã hết thời gian học", startDate: "2026-01-06", endDate: "2026-02-05", maxSize: 8 })
      .returning();
    await template(ended!.id, 6, evening.id);

    const result = await svc.generateNextWeekForAll(f.admin, now);
    expect(result).toMatchObject({ created: 1, classCount: 2 });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/^B: Bỏ qua buổi 10\/02\/2026 08:00: .*Phòng/);
    expect(result.warnings[1]).toBe("Không sinh buổi cho Z: tuần sau nằm ngoài thời gian học của lớp.");
    expect(await inWeek(f.classA.id)).toHaveLength(1);
    expect(await inWeek(f.classB.id)).toEqual([]);
    expect(await sessionsOf(ended!.id)).toEqual([]);
  });

  it("theo quyền Thêm của Thời khóa biểu; phạm vi lớp của mình chỉ sinh cho lớp mình", async () => {
    await template(f.classA.id, 2, morning.id);
    await template(f.classB.id, 4, morning.id);
    await expect(svc.generateNextWeekForAll(f.actorA, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(svc.generateNextWeekForAll(withMenus(f.actorA, "own", { timetable: { view: true, add: false, edit: true } }), now)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await svc.generateNextWeekForAll(withMenus(f.actorA, "own", { timetable: FULL }), now)).toMatchObject({ created: 1, classCount: 1 });
    expect(await inWeek(f.classA.id)).toHaveLength(1);
    expect(await inWeek(f.classB.id)).toEqual([]);
    expect(await svc.generateNextWeekForAll(withMenus(f.actorA, "all", { timetable: FULL }), now)).toMatchObject({ created: 1, classCount: 2 });
    expect(await inWeek(f.classB.id)).toHaveLength(1);
  });
});

describe("tác vụ hằng ngày bổ sung buổi đến hết tuần sau", () => {
  it("bổ sung buổi còn thiếu từ hôm nay đến hết tuần sau cho mọi lớp đang mở có lịch mẫu; không tạo lại buổi đã hủy; chạy lại không tạo trùng", async () => {
    await template(f.classA.id, 2, morning.id); // Thứ Ba: 10/02 (03/02 đã qua)
    const [thuB] = await template(f.classB.id, 4, evening.id); // Thứ Năm: 05/02, 12/02
    // Buổi 12/02 của lớp B đã bị hủy: không được tạo lại.
    const cancelled = await hold({ classId: f.classB.id, date: "2026-02-12", templateId: thuB!.id, startTime: "18:00", endTime: "19:30", timeSlotId: evening.id, status: "cancelled" });
    const [closed, ended, bare] = await db
      .insert(classes)
      .values([
        { code: "D", name: "Lớp đã đóng", startDate: "2026-01-06", endDate: "2026-03-31", maxSize: 8, status: "closed" },
        { code: "Z", name: "Lớp đã hết thời gian học", startDate: "2026-01-06", endDate: "2026-02-03", maxSize: 8 },
        { code: "E", name: "Lớp chưa có lịch mẫu", startDate: "2026-01-06", endDate: "2026-03-31", maxSize: 8 },
      ])
      .returning();
    await template(closed!.id, 5, evening.id);
    await template(ended!.id, 6, evening.id);

    expect(await svc.topUpSessions(now)).toEqual({ range: RANGE, classCount: 2, created: 2 });
    expect((await sessionsOf(f.classA.id)).map((s) => [s.date, s.teacherId, s.roomId])).toEqual([["2026-02-10", f.teacherA.id, f.room.id]]);
    expect((await sessionsOf(f.classB.id)).map((s) => [s.date, s.status])).toEqual([
      ["2026-02-05", "planned"],
      ["2026-02-12", "cancelled"],
    ]);
    expect((await sessionsOf(f.classB.id))[1]!.id).toBe(cancelled.id);
    for (const cls of [closed, ended, bare]) expect(await sessionsOf(cls!.id)).toEqual([]);
    // Nhật ký: mỗi lớp có buổi được tạo một dòng, không gắn với người dùng nào.
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "sessions_generated"));
    expect(logs.map((l) => l.userId)).toEqual([null, null]);

    // Chạy lại (hằng ngày): không tạo trùng, không ghi thêm nhật ký.
    expect(await svc.topUpSessions(now)).toMatchObject({ created: 0, classCount: 2 });
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "sessions_generated"))).toHaveLength(2);
    // Sang tuần sau (Thứ Hai 09/02): khoảng mới 09/02 – 22/02, chỉ thêm buổi của tuần 16/02 – 22/02.
    expect(await svc.topUpSessions(new Date("2026-02-09T05:00:00Z"))).toMatchObject({ range: { from: "2026-02-09", to: "2026-02-22" }, created: 2 });
    expect((await sessionsOf(f.classA.id)).map((s) => s.date)).toEqual(["2026-02-10", "2026-02-17"]);
    // Buổi bị xóa hẳn (không phải hủy) mà lịch mẫu vẫn có thì được tạo lại.
    await db.delete(sessions).where(and(eq(sessions.classId, f.classA.id), eq(sessions.date, "2026-02-17")));
    expect(await svc.topUpSessions(new Date("2026-02-09T05:00:00Z"))).toMatchObject({ created: 1 });
  });

  it("đường dẫn cron chỉ chạy khi có đúng khóa CRON_SECRET; chỉ trả về số liệu tổng", async () => {
    const call = (authorization?: string) =>
      cronRoute(new Request("https://example.test/api/cron/generate-sessions", { headers: authorization ? { authorization } : {} }));
    const before = process.env.CRON_SECRET;
    try {
      // Chưa khai báo khóa: luôn từ chối.
      delete process.env.CRON_SECRET;
      expect((await call()).status).toBe(401);
      expect((await call("Bearer ")).status).toBe(401);
      process.env.CRON_SECRET = "khoa-thu-nghiem-0123456789";
      expect((await call()).status).toBe(401);
      expect((await call("Bearer sai-khoa")).status).toBe(401);
      expect((await call("khoa-thu-nghiem-0123456789")).status).toBe(401);
      const ok = await call("Bearer khoa-thu-nghiem-0123456789");
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["classes", "created", "from", "ok", "to"]);
      expect(body.ok).toBe(true);
    } finally {
      if (before === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = before;
    }
  });
});
