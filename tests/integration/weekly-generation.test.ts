import { and, asc, between, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attendances, classes, holidays, makeupAssignments, rooms, scheduleTemplates, sessions, starLogs, teachers, timeSlots } from "@/db/schema";
import { DEFAULT_PERMISSIONS, type RolePermissions } from "@/lib/permissions";
import type { Actor } from "@/server/guard";
import * as svc from "@/server/services/sessions";
import { type Fixture, resetDb, seedFixture } from "./helpers";

// Lớp A và B: 06/01/2026 (Thứ Ba) → 31/03/2026 (Thứ Ba), chung phòng "Lab"; GV chính A và B.
// "Hôm nay" là Thứ Tư 04/02/2026: tuần này 02/02 – 08/02, TUẦN SAU 09/02 – 15/02.
const now = new Date("2026-02-04T05:00:00Z");
const WEEK = { from: "2026-02-09", to: "2026-02-15" };
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
const hold = async (values: Partial<typeof sessions.$inferInsert> & { classId: string; date: string }) =>
  (await db.insert(sessions).values({ startTime: "08:00", endTime: "09:30", timeSlotId: morning.id, ...values }).returning())[0]!;
const withMenus = (actor: Actor, scope: RolePermissions["scope"], menus: Partial<RolePermissions["menus"]>): Actor => ({
  ...actor,
  perms: { scope, menus: { ...DEFAULT_PERMISSIONS.teacher.menus, ...menus } },
});
const FULL = { view: true, add: true, edit: true };

describe("nút Sinh buổi học tuần sau ở trang chi tiết lớp", () => {
  it("chỉ tạo buổi của tuần sau theo lịch mẫu, bỏ ngày nghỉ; các tuần khác không bị đụng", async () => {
    const [teacherC] = await db.insert(teachers).values({ code: "GVC", fullName: "GV C" }).returning();
    await template(f.classA.id, 2, morning.id);
    await template(f.classA.id, 4, evening.id, { teacherId: teacherC!.id, assistantTeacherId: f.teacherA.id });
    // Buổi đã có ở tuần này và ở tuần sau nữa (xếp tay): giữ nguyên.
    const thisWeek = await hold({ classId: f.classA.id, date: "2026-02-05" });
    const later = await hold({ classId: f.classA.id, date: "2026-02-17" });

    const result = await svc.generateNextWeek(f.admin, f.classA.id, now);
    expect(result).toEqual({ week: WEEK, created: 2, removed: 0, alreadyExisting: 0, warnings: [] });
    const made = await inWeek(f.classA.id);
    expect(made.map((s) => [s.date, s.startTime, s.teacherId, s.assistantTeacherId, s.roomId, s.status, s.kind])).toEqual([
      ["2026-02-10", "08:00:00", f.teacherA.id, null, f.room.id, "planned", "regular"],
      ["2026-02-12", "18:00:00", teacherC!.id, f.teacherA.id, f.room.id, "planned", "regular"],
    ]);
    expect((await sessionsOf(f.classA.id)).map((s) => s.id)).toEqual([thisWeek.id, made[0]!.id, made[1]!.id, later.id]);

    // Trang chi tiết lớp: tuần sẽ sinh và số buổi lớp đã có trong tuần đó.
    expect((await svc.classScheduleOverview(f.admin, f.classA.id, "2026-02-04")).nextWeek).toEqual({ ...WEEK, count: 2 });

    // Bấm lại: xếp lại đúng hai buổi đó, không tạo trùng. Thêm ngày nghỉ 10/02 thì tuần sau chỉ còn buổi Thứ Năm.
    expect(await svc.generateNextWeek(f.admin, f.classA.id, now)).toMatchObject({ created: 2, removed: 2 });
    expect(await inWeek(f.classA.id)).toHaveLength(2);
    await db.insert(holidays).values({ date: "2026-02-10", reason: "Nghỉ" });
    expect(await svc.generateNextWeek(f.admin, f.classA.id, now)).toMatchObject({ created: 1, removed: 2 });
    expect((await inWeek(f.classA.id)).map((s) => s.date)).toEqual(["2026-02-12"]);
    expect(await sessionsOf(f.classA.id)).toHaveLength(3);
  });

  it("xếp lại buổi chưa dạy của tuần sau kể cả buổi sửa tay; giữ buổi đã điểm danh, ghi sao, hủy, buổi bù và buổi có em được xếp học bù", async () => {
    const [tpl] = await template(f.classA.id, 3, evening.id);
    const studentId = f.students[0]!.id;
    // Buổi của tuần sau đang có trên Thời khóa biểu.
    const manual = await hold({ classId: f.classA.id, date: "2026-02-09" }); // xếp tay, chưa dạy → bỏ
    const edited = await hold({ classId: f.classA.id, date: "2026-02-11", templateId: tpl!.id, startTime: "19:00", endTime: "20:30", timeSlotId: null }); // sửa giờ riêng → xếp lại
    const attended = await hold({ classId: f.classA.id, date: "2026-02-10" });
    await db.insert(attendances).values({ sessionId: attended.id, studentId, status: "present" });
    const starred = await hold({ classId: f.classA.id, date: "2026-02-12" });
    await db.insert(starLogs).values({ sessionId: starred.id, studentId, stars: 2 });
    const cancelled = await hold({ classId: f.classA.id, date: "2026-02-13", status: "cancelled" });
    const makeupKind = await hold({ classId: f.classA.id, date: "2026-02-14", kind: "makeup" });
    // Một em của lớp B vắng buổi 03/02 đã được xếp học bù vào buổi 15/02 của lớp A.
    const absent = await hold({ classId: f.classB.id, date: "2026-02-03", status: "done", startTime: "10:00", endTime: "11:30", timeSlotId: null });
    const target = await hold({ classId: f.classA.id, date: "2026-02-15" });
    await db.insert(makeupAssignments).values({ absentSessionId: absent.id, makeupSessionId: target.id, studentId: f.students[2]!.id });
    // Buổi sửa tay ở tuần này: không thuộc tuần sau nên không bị đụng.
    const thisWeek = await hold({ classId: f.classA.id, date: "2026-02-06", startTime: "09:00", endTime: "10:30", timeSlotId: null });

    const result = await svc.generateNextWeek(f.admin, f.classA.id, now);
    expect(result).toMatchObject({ created: 1, removed: 2, warnings: [] });
    const ids = (await sessionsOf(f.classA.id)).map((s) => s.id);
    expect(ids).not.toContain(manual.id);
    expect(ids).not.toContain(edited.id);
    for (const kept of [attended, starred, cancelled, makeupKind, target, thisWeek]) expect(ids).toContain(kept.id);
    // Buổi Thứ Tư 11/02 trở lại đúng giờ, ca của lịch mẫu.
    const wednesday = (await inWeek(f.classA.id)).find((s) => s.date === "2026-02-11")!;
    expect(wednesday).toMatchObject({ startTime: "18:00:00", endTime: "19:30:00", timeSlotId: evening.id, templateId: tpl!.id, teacherId: f.teacherA.id });
    expect(await db.select().from(makeupAssignments)).toHaveLength(1);
  });

  it("buổi trùng giáo viên hoặc phòng với lớp khác không được tạo và được báo lại", async () => {
    await template(f.classA.id, 2, morning.id);
    await template(f.classB.id, 2, morning.id);
    await svc.generateNextWeek(f.admin, f.classA.id, now);
    const clash = await svc.generateNextWeek(f.admin, f.classB.id, now);
    expect(clash.created).toBe(0);
    expect(clash.warnings).toHaveLength(1);
    expect(clash.warnings[0]).toMatch(/^Bỏ qua buổi 10\/02\/2026 08:00: .*Phòng/);
    expect(await inWeek(f.classB.id)).toEqual([]);
  });

  it("chỉ sinh trong thời gian học của lớp: tuần có ngày kết thúc, tuần khai giảng, tuần nằm ngoài thì báo lỗi", async () => {
    await template(f.classA.id, 2, morning.id);
    await template(f.classA.id, 4, morning.id);
    // Hôm nay 25/03 → tuần sau 30/03 – 05/04; lớp kết thúc Thứ Ba 31/03 nên chỉ có buổi 31/03.
    await svc.generateNextWeek(f.admin, f.classA.id, new Date("2026-03-25T05:00:00Z"));
    expect((await sessionsOf(f.classA.id)).map((s) => s.date)).toEqual(["2026-03-31"]);
    // Hôm nay 01/04 → tuần sau 06/04 – 12/04 nằm ngoài thời gian học của lớp.
    await expect(svc.generateNextWeek(f.admin, f.classA.id, new Date("2026-04-01T05:00:00Z"))).rejects.toMatchObject({
      code: "VALIDATION",
      message: expect.stringContaining("nằm ngoài thời gian học của lớp"),
    });

    // Lớp khai giảng Thứ Tư 11/02 (trong tuần sau), lịch mẫu Thứ Ba + Thứ Năm: buổi đầu vào đúng ngày khai giảng, rồi Thứ Năm.
    const [fresh] = await db
      .insert(classes)
      .values({ code: "C", name: "Lớp C", startDate: "2026-02-11", endDate: "2026-04-30", maxSize: 8 })
      .returning();
    await template(fresh!.id, 2, evening.id);
    await template(fresh!.id, 4, evening.id);
    expect(await svc.generateNextWeek(f.admin, fresh!.id, now)).toMatchObject({ created: 2 });
    expect((await sessionsOf(fresh!.id)).map((s) => s.date)).toEqual(["2026-02-11", "2026-02-12"]);
  });

  it("lớp đã đóng, lớp chưa có lịch mẫu, thiếu quyền Sửa của Lớp học, lớp ngoài phạm vi: máy chủ từ chối", async () => {
    await expect(svc.generateNextWeek(f.admin, f.classA.id, now)).rejects.toMatchObject({ code: "VALIDATION", message: "Lớp chưa có lịch mẫu." });
    await template(f.classA.id, 2, morning.id);
    await template(f.classB.id, 4, morning.id);
    await expect(svc.generateNextWeek(f.actorA, f.classA.id, now)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const editor = withMenus(f.actorA, "own", { classes: FULL });
    await expect(svc.generateNextWeek(editor, f.classB.id, now)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await svc.generateNextWeek(editor, f.classA.id, now)).toMatchObject({ created: 1 });
    await db.update(classes).set({ status: "closed" }).where(eq(classes.id, f.classA.id));
    await expect(svc.generateNextWeek(f.admin, f.classA.id, now)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await sessionsOf(f.classB.id)).toEqual([]);
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
    expect(result).toEqual({ week: WEEK, created: 2, removed: 0, alreadyExisting: 1, warnings: [], classCount: 3 });
    expect((await inWeek(f.classB.id)).map((s) => [s.date, s.teacherId])).toEqual([["2026-02-12", f.teacherB.id]]);
    expect((await inWeek(lend!.id)).map((s) => s.date)).toEqual(["2026-02-13"]);
    expect(await inWeek(f.classA.id)).toEqual([edited]);
    expect((await sessionsOf(f.classB.id)).map((s) => s.id)).toContain(other.id);
    expect(await sessionsOf(f.classB.id)).toHaveLength(2);
    expect(await sessionsOf(closed!.id)).toEqual([]);
    expect(await sessionsOf(bare!.id)).toEqual([]);

    expect(await svc.generateNextWeekForAll(f.admin, now)).toMatchObject({ created: 0, alreadyExisting: 3, removed: 0 });
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
