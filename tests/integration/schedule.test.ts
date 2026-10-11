import { and, asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attendances, auditLogs, classes, enrollments, holidays, levels, rooms, scheduleTemplates, sessions, starLogs, timeSlots } from "@/db/schema";
import * as attendance from "@/server/services/attendance";
import * as catalog from "@/server/services/catalog";
import * as svc from "@/server/services/sessions";
import { type Fixture, resetDb, seedFixture } from "./helpers";

// Lớp A và B: 05/01/2026 (Thứ Hai) → 31/03/2026, dùng chung phòng "Lab" (10 chỗ).
let f: Fixture;
let morning: typeof timeSlots.$inferSelect;
let late: typeof timeSlots.$inferSelect;

beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  [morning, late] = (await db
    .insert(timeSlots)
    .values([
      { name: "Ca sáng", frame: 1, defaultStart: "08:00", defaultEnd: "09:30" },
      { name: "Ca sáng muộn", frame: 1, defaultStart: "09:00", defaultEnd: "10:30" },
    ])
    .returning()) as [typeof timeSlots.$inferSelect, typeof timeSlots.$inferSelect];
});

const template = (classId: string, weekday: number, slotId: string, extra: Partial<typeof scheduleTemplates.$inferInsert> = {}) =>
  db.insert(scheduleTemplates).values({ classId, weekday, timeSlotId: slotId, ...extra });
const sessionsOf = (classId: string) =>
  db.select().from(sessions).where(eq(sessions.classId, classId)).orderBy(asc(sessions.date), asc(sessions.startTime));
const at = (iso: string) => new Date(`${iso}T05:00:00Z`); // 12:00 giờ Việt Nam

describe("sinh buổi học", () => {
  it("sinh từ lịch mẫu, bỏ ngày nghỉ toàn trung tâm và của riêng lớp, chạy lại không tạo trùng", async () => {
    await template(f.classA.id, 2, morning.id);
    await template(f.classA.id, 4, morning.id);
    await db.insert(holidays).values([
      { date: "2026-01-13", reason: "Nghỉ toàn trung tâm" },
      { date: "2026-01-22", reason: "Lớp A nghỉ", classId: f.classA.id },
      { date: "2026-01-29", reason: "Lớp B nghỉ", classId: f.classB.id },
    ]);
    const result = await svc.generateSessions(f.admin, f.classA.id);
    const list = await sessionsOf(f.classA.id);
    const dates = list.map((s) => s.date);
    expect(result.created).toBe(list.length);
    expect(dates).toContain("2026-01-06");
    expect(dates).not.toContain("2026-01-13");
    expect(dates).not.toContain("2026-01-22");
    expect(dates).toContain("2026-01-29"); // ngày nghỉ của lớp khác không ảnh hưởng
    expect(list[0]).toMatchObject({ startTime: "08:00:00", endTime: "09:30:00", roomId: f.room.id, teacherId: f.teacherA.id, status: "planned" });

    const again = await svc.generateSessions(f.admin, f.classA.id);
    expect(again).toMatchObject({ created: 0, alreadyExisting: list.length });
    expect((await sessionsOf(f.classA.id)).length).toBe(list.length);
  });

  it("đổi giờ một buổi không đổi buổi khác, không đổi ca; đổi giờ ca không đổi buổi đã sinh", async () => {
    await template(f.classA.id, 2, morning.id);
    await svc.generateSessions(f.admin, f.classA.id);
    const [first, second] = await sessionsOf(f.classA.id);
    await svc.updateSession(f.admin, { id: first!.id, startTime: "10:00", endTime: "11:45", roomId: f.room.id, teacherId: f.teacherA.id, assistantTeacherId: null, content: null, note: null });

    const after = await sessionsOf(f.classA.id);
    expect(after.find((s) => s.id === first!.id)).toMatchObject({ startTime: "10:00:00", endTime: "11:45:00" });
    expect(after.filter((s) => s.id !== first!.id).every((s) => s.startTime === "08:00:00" && s.endTime === "09:30:00")).toBe(true);
    const [slot] = await db.select().from(timeSlots).where(eq(timeSlots.id, morning.id));
    expect(slot).toMatchObject({ defaultStart: "08:00:00", defaultEnd: "09:30:00" });

    await catalog.updateTimeSlot(f.admin, morning.id, { name: "Ca sáng", frame: 1, defaultStart: "07:00", defaultEnd: "08:30" });
    const afterSlotChange = await sessionsOf(f.classA.id);
    expect(afterSlotChange.find((s) => s.id === second!.id)).toMatchObject({ startTime: "08:00:00", endTime: "09:30:00" });

    // Sinh lại không ghi đè buổi đã sửa giờ.
    await svc.generateSessions(f.admin, f.classA.id);
    expect((await sessionsOf(f.classA.id)).find((s) => s.id === first!.id)).toMatchObject({ startTime: "10:00:00" });
  });

  it("buổi trùng phòng với lớp khác không được tạo và được báo lại", async () => {
    await template(f.classA.id, 2, morning.id);
    await svc.generateSessions(f.admin, f.classA.id);
    // Lớp B cùng Thứ Ba, cùng ca + khung giờ, cùng phòng Lab với lớp A.
    await template(f.classB.id, 2, morning.id);
    const result = await svc.generateSessions(f.admin, f.classB.id);
    // Lớp A chiếm cả 13 Thứ Ba trong thời gian học (06/01–31/03); 13 Thứ Ba đó của lớp B bị trùng phòng.
    // Buổi chỉ xếp trong thời gian của lớp: không xếp sang các tuần sau và không lùi ngày kết thúc.
    expect((await sessionsOf(f.classA.id)).map((x) => x.date)).toHaveLength(13);
    expect(result.conflicts).toHaveLength(13);
    expect(result.conflicts[0]!.reason).toContain("Phòng");
    expect(result.conflicts[0]!.reason).toContain("(cùng ca, cùng khung giờ)");
    expect(result.created).toBe(0);
    expect(await sessionsOf(f.classB.id)).toEqual([]);
    expect(result.warnings.join(" ")).not.toContain("được lùi");
    const [classB] = await db.select().from(classes).where(eq(classes.id, f.classB.id));
    expect(classB!.endDate).toBe("2026-03-31");
    // Lớp học tiếp thì dời ngày kết thúc rồi sinh thêm: các Thứ Ba sau 31/03 không còn trùng.
    await db.update(classes).set({ endDate: "2026-04-14" }).where(eq(classes.id, f.classB.id));
    expect((await svc.generateSessions(f.admin, f.classB.id)).created).toBe(2);
    expect((await sessionsOf(f.classB.id)).map((x) => x.date)).toEqual(["2026-04-07", "2026-04-14"]);
  });

  it("khác khung giờ thì không trùng: cùng GV, cùng phòng, cùng thứ vẫn sinh đủ buổi dù giờ hai khung chồng nhau", async () => {
    await template(f.classA.id, 2, morning.id);
    await svc.generateSessions(f.admin, f.classA.id);
    // Lớp B: cùng Thứ Ba, cùng phòng Lab, cùng GV A nhưng ở khung khác (09:00–10:30 chồng lên 08:00–09:30).
    await template(f.classB.id, 2, late.id, { teacherId: f.teacherA.id });
    const result = await svc.generateSessions(f.admin, f.classB.id);
    expect(result.conflicts).toEqual([]);
    expect(result.created).toBe(13);
    const list = await sessionsOf(f.classB.id);
    expect([list[0]!.date, list.at(-1)!.date]).toEqual(["2026-01-06", "2026-03-31"]);
    expect(list.every((x) => x.teacherId === f.teacherA.id && x.roomId === f.room.id)).toBe(true);
  });

  it("cảnh báo (không chặn) khi sĩ số vượt sức chứa phòng", async () => {
    await db.update(rooms).set({ capacity: 1 }).where(eq(rooms.id, f.room.id));
    await template(f.classA.id, 2, morning.id);
    const result = await svc.generateSessions(f.admin, f.classA.id);
    expect(result.created).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toContain("chỉ chứa 1");
  });
});

describe("trùng lịch theo ca + khung giờ", () => {
  let a: typeof sessions.$inferSelect;
  let b: typeof sessions.$inferSelect;
  let room2: typeof rooms.$inferSelect;

  beforeEach(async () => {
    [room2] = (await db.insert(rooms).values({ name: "Lab 2", capacity: 10 }).returning()) as [typeof rooms.$inferSelect];
    await template(f.classA.id, 2, morning.id);
    await template(f.classB.id, 2, morning.id, { roomId: room2.id });
    await svc.generateSessions(f.admin, f.classA.id);
    await svc.generateSessions(f.admin, f.classB.id);
    a = (await sessionsOf(f.classA.id))[0]!; // 06/01 08:00–09:30, GV A, Lab
    b = (await sessionsOf(f.classB.id))[0]!; // 06/01 08:00–09:30, GV B, Lab 2
  });

  const edit = (s: typeof sessions.$inferSelect, patch: Partial<{ startTime: string; endTime: string; roomId: string | null; teacherId: string | null }>) =>
    svc.updateSession(f.admin, {
      id: s.id,
      startTime: s.startTime.slice(0, 5),
      endTime: s.endTime.slice(0, 5),
      roomId: s.roomId,
      teacherId: s.teacherId,
      assistantTeacherId: s.assistantTeacherId,
      content: null,
      note: null,
      ...patch,
    });

  it("chặn trùng phòng và trùng GV khi cùng ca + khung giờ, kể cả khi giờ riêng của buổi đã sửa", async () => {
    await expect(edit(b, { roomId: f.room.id })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(edit(b, { teacherId: f.teacherA.id })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(edit(b, { roomId: f.room.id, startTime: "09:00", endTime: "10:00" })).rejects.toMatchObject({ code: "CONFLICT" });
    // Buổi vẫn thuộc khung giờ đó nên sửa giờ riêng không tránh được trùng.
    await expect(edit(b, { roomId: f.room.id, teacherId: f.teacherA.id, startTime: "09:30", endTime: "11:00" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("buổi đã hủy không còn chiếm GV/phòng; khôi phục thì kiểm tra lại", async () => {
    await svc.cancelSession(f.admin, { id: a.id, note: "GV bận" });
    await expect(edit(b, { roomId: f.room.id, teacherId: f.teacherA.id })).resolves.toBeDefined();
    await expect(svc.restoreSession(f.admin, a.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("dời buổi: lưu ngày gốc, chặn nếu trùng, sinh lại không tạo lại buổi gốc", async () => {
    const second = (await sessionsOf(f.classA.id))[1]!; // 13/01
    await expect(
      svc.rescheduleSession(f.admin, { id: b.id, date: "2026-01-14", startTime: "08:30", endTime: "10:00" }),
    ).resolves.toBeDefined(); // ngày trống
    await expect(svc.rescheduleSession(f.admin, { id: a.id, date: second.date, startTime: "09:00", endTime: "10:00" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await svc.rescheduleSession(f.admin, { id: a.id, date: "2026-01-07", startTime: "14:00", endTime: "15:30" });
    const [moved] = await db.select().from(sessions).where(eq(sessions.id, a.id));
    expect(moved).toMatchObject({ date: "2026-01-07", originalDate: "2026-01-06", startTime: "14:00:00" });
    const before = (await sessionsOf(f.classA.id)).length;
    expect((await svc.generateSessions(f.admin, f.classA.id)).created).toBe(0);
    expect((await sessionsOf(f.classA.id)).length).toBe(before);
  });

  it("dạy thay: lưu cả GV gốc lẫn GV thay, chặn nếu GV thay đang bận", async () => {
    await expect(svc.setSubstitute(f.admin, { id: a.id, substituteTeacherId: f.teacherB.id })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(svc.setSubstitute(f.admin, { id: a.id, substituteTeacherId: f.teacherA.id })).rejects.toMatchObject({ code: "VALIDATION" });
    await svc.cancelSession(f.admin, { id: b.id, note: null });
    await svc.setSubstitute(f.admin, { id: a.id, substituteTeacherId: f.teacherB.id });
    const [row] = await db.select().from(sessions).where(eq(sessions.id, a.id));
    expect(row).toMatchObject({ teacherId: f.teacherA.id, substituteTeacherId: f.teacherB.id });

    // GV B (dạy thay) điểm danh được đúng buổi này, không vào được buổi khác của lớp A.
    const other = (await sessionsOf(f.classA.id))[1]!;
    await expect(attendance.getAttendanceSheet(f.actorB, a.id, at("2026-01-06"))).resolves.toBeDefined();
    await expect(attendance.getAttendanceSheet(f.actorB, other.id, at("2026-01-13"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    // GV gốc đã được thay nên rảnh; GV thay thì bận ở khung giờ đó.
    await svc.restoreSession(f.admin, b.id).then(
      () => expect.fail("GV B đang dạy thay nên không thể khôi phục buổi trùng giờ"),
      (e) => expect(e).toMatchObject({ code: "CONFLICT" }),
    );
  });

  it("buổi bù chỉ gồm học viên được chọn và phải thuộc lớp", async () => {
    const [a1, , b1] = f.students;
    const input = { classId: f.classA.id, date: "2026-01-08", startTime: "14:00", endTime: "15:00", roomId: f.room.id, teacherId: f.teacherA.id, note: null };
    await expect(svc.createMakeupSession(f.admin, { ...input, studentIds: [a1!.id, b1!.id] })).rejects.toMatchObject({ code: "VALIDATION" });
    const created = await svc.createMakeupSession(f.admin, { ...input, studentIds: [a1!.id] });
    const sheet = await attendance.getAttendanceSheet(f.actorA, created.id, at("2026-01-08"));
    expect(sheet.rows.map((r) => r.code)).toEqual(["A1"]);
    // Buổi bù cũng bị kiểm tra trùng.
    await expect(svc.createMakeupSession(f.admin, { ...input, startTime: "14:30", endTime: "15:30", studentIds: [a1!.id] })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("Admin xếp tay một buổi vào ngày × ca: giờ theo ca, mặc định GV chính và phòng của lớp, vẫn chặn trùng", async () => {
    // Thứ Tư 07/01 chưa có buổi nào.
    const created = await svc.createManualSession(f.admin, { classId: f.classA.id, date: "2026-01-07", timeSlotId: late.id, teacherId: null, roomId: null });
    const [row] = await db.select().from(sessions).where(eq(sessions.id, created.id));
    expect(row).toMatchObject({
      date: "2026-01-07",
      startTime: "09:00:00",
      endTime: "10:30:00",
      timeSlotId: late.id,
      teacherId: f.teacherA.id,
      roomId: f.room.id,
      templateId: null,
      kind: "regular",
      status: "planned",
    });
    expect(created.warnings).toEqual([]);

    // Cùng ngày, cùng ca + khung giờ: trùng phòng Lab → chặn.
    await expect(
      svc.createManualSession(f.admin, { classId: f.classB.id, date: "2026-01-07", timeSlotId: late.id, teacherId: null, roomId: null }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("Phòng") });
    // Đổi phòng nhưng chọn GV A đang dạy khung đó → trùng GV.
    await expect(
      svc.createManualSession(f.admin, { classId: f.classB.id, date: "2026-01-07", timeSlotId: late.id, teacherId: f.teacherA.id, roomId: room2.id }),
    ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("Giáo viên") });
    // Phòng khác, GV khác thì được; chọn GV/phòng riêng được lưu đúng.
    const other = await svc.createManualSession(f.admin, { classId: f.classB.id, date: "2026-01-07", timeSlotId: late.id, teacherId: f.teacherB.id, roomId: room2.id });
    expect((await db.select().from(sessions).where(eq(sessions.id, other.id)))[0]).toMatchObject({ teacherId: f.teacherB.id, roomId: room2.id });

    // Buổi xếp tay không bị sinh buổi tạo trùng hay ghi đè, và GV của lớp điểm danh được.
    const before = (await sessionsOf(f.classA.id)).length;
    expect((await svc.generateSessions(f.admin, f.classA.id)).created).toBe(0);
    expect((await sessionsOf(f.classA.id)).length).toBe(before);
    await expect(attendance.getAttendanceSheet(f.actorA, created.id, at("2026-01-07"))).resolves.toMatchObject({ recorded: false });
  });

  it("xếp tay: cảnh báo ngày nghỉ và ngày ngoài thời gian lớp; từ chối lớp đã đóng và người không phải Admin", async () => {
    await db.insert(holidays).values({ date: "2026-01-09", reason: "Nghỉ lễ" });
    const onHoliday = await svc.createManualSession(f.admin, { classId: f.classA.id, date: "2026-01-09", timeSlotId: morning.id, teacherId: null, roomId: null });
    expect(onHoliday.warnings.join(" ")).toContain("ngày nghỉ");
    const outside = await svc.createManualSession(f.admin, { classId: f.classA.id, date: "2026-04-15", timeSlotId: morning.id, teacherId: null, roomId: null });
    expect(outside.warnings.join(" ")).toContain("ngoài thời gian học");

    const input = { classId: f.classA.id, date: "2026-01-08", timeSlotId: morning.id, teacherId: null, roomId: null };
    await expect(svc.createManualSession(f.actorA, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(svc.createManualSession(f.admin, { ...input, timeSlotId: f.classA.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await db.update(classes).set({ status: "closed" }).where(eq(classes.id, f.classA.id));
    await expect(svc.createManualSession(f.admin, input)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("GV không được sinh buổi hay điều chỉnh lịch", async () => {
    const denied = { code: "FORBIDDEN" };
    await expect(svc.generateSessions(f.actorA, f.classA.id)).rejects.toMatchObject(denied);
    await expect(edit(a, {}).then(() => svc.updateSession(f.actorA, { id: a.id, startTime: "07:00", endTime: "08:00", roomId: null, teacherId: null, assistantTeacherId: null, content: null, note: null }))).rejects.toMatchObject(denied);
    await expect(svc.cancelSession(f.actorA, { id: a.id, note: null })).rejects.toMatchObject(denied);
    await expect(svc.setSubstitute(f.actorA, { id: b.id, substituteTeacherId: f.teacherA.id })).rejects.toMatchObject(denied);
    await expect(svc.createTemplate(f.actorA, { classId: f.classA.id, weekday: 1, timeSlotId: morning.id, roomId: null, teacherId: null, assistantTeacherId: null, startTime: null, endTime: null })).rejects.toMatchObject(denied);
    await expect(attendance.unlockAttendance(f.actorA, a.id)).rejects.toMatchObject(denied);
  });

  it("GV chỉ thấy buổi của lớp mình trong TKB", async () => {
    const range = { from: "2026-01-05", to: "2026-01-11" };
    expect((await svc.listSessions(f.actorA, range)).map((s) => s.classCode)).toEqual(["A"]);
    expect((await svc.listSessions(f.actorA, { ...range, classId: f.classB.id })).length).toBe(0);
    expect((await svc.listSessions(f.admin, range)).length).toBe(2);
    await expect(svc.getSession(f.actorA, b.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("điểm danh", () => {
  let first: typeof sessions.$inferSelect;
  let later: typeof sessions.$inferSelect;
  const entries = (rows: { studentId: string }[], status: "present" | "absent" = "present") =>
    rows.map((r) => ({ studentId: r.studentId, status, note: null }));

  beforeEach(async () => {
    await template(f.classA.id, 2, morning.id);
    await svc.generateSessions(f.admin, f.classA.id);
    const list = await sessionsOf(f.classA.id);
    first = list[0]!; // 06/01
    later = list.find((s) => s.date === "2026-02-10")!;
  });

  it("danh sách chỉ gồm học viên đang ghi danh tại ngày học, mặc định Có mặt", async () => {
    // X1 vào lớp từ 01/02; A2 rời lớp từ 01/02.
    await db.insert(enrollments).values({ classId: f.classA.id, studentId: f.students[4]!.id, joinedAt: "2026-02-01" });
    await db
      .update(enrollments)
      .set({ leftAt: "2026-02-01", status: "left" })
      .where(and(eq(enrollments.classId, f.classA.id), eq(enrollments.studentId, f.students[1]!.id)));

    const early = await attendance.getAttendanceSheet(f.actorA, first.id, at("2026-01-06"));
    expect(early.rows.map((r) => r.code).sort()).toEqual(["A1", "A2"]);
    expect(early.rows.every((r) => r.status === "present")).toBe(true);
    expect(early.recorded).toBe(false);
    const late2 = await attendance.getAttendanceSheet(f.actorA, later.id, at("2026-02-10"));
    expect(late2.rows.map((r) => r.code).sort()).toEqual(["A1", "X1"]);
  });

  it("lưu điểm danh, sửa lại thì ghi nhật ký giá trị cũ và mới", async () => {
    const sheet = await attendance.getAttendanceSheet(f.actorA, first.id, at("2026-01-06"));
    await attendance.saveAttendance(f.actorA, { sessionId: first.id, content: "Bài 1", entries: entries(sheet.rows) }, at("2026-01-06"));
    const [done] = await db.select().from(sessions).where(eq(sessions.id, first.id));
    expect(done).toMatchObject({ status: "done", content: "Bài 1" });

    const changed = sheet.rows.map((r, i) => ({ studentId: r.studentId, status: i === 0 ? ("absent" as const) : ("present" as const), note: i === 0 ? "ốm" : null }));
    const result = await attendance.saveAttendance(f.actorA, { sessionId: first.id, content: null, entries: changed }, at("2026-01-07"));
    expect(result.changed).toBe(1);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "attendance_updated"));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ userId: f.actorA.userId, oldValue: { status: "present", note: null }, newValue: { status: "absent", note: "ốm" } });
    const reread = await attendance.getAttendanceSheet(f.actorA, first.id, at("2026-01-07"));
    expect(reread.recorded).toBe(true);
    expect(reread.rows.find((r) => r.studentId === changed[0]!.studentId)).toMatchObject({ status: "absent", note: "ốm" });
  });

  it("GV lớp khác không xem và không lưu được điểm danh, kể cả khi gửi đúng id", async () => {
    const sheet = await attendance.getAttendanceSheet(f.actorA, first.id, at("2026-01-06"));
    await expect(attendance.getAttendanceSheet(f.actorB, first.id, at("2026-01-06"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      attendance.saveAttendance(f.actorB, { sessionId: first.id, content: null, entries: entries(sheet.rows, "absent") }, at("2026-01-06")),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await attendance.getAttendanceSheet(f.admin, first.id, at("2026-01-06"))).recorded).toBe(false);
  });

  it("từ chối danh sách có học viên ngoài buổi hoặc thiếu học viên", async () => {
    const sheet = await attendance.getAttendanceSheet(f.actorA, first.id, at("2026-01-06"));
    const outsider = { studentId: f.students[2]!.id, status: "present" as const, note: null };
    await expect(
      attendance.saveAttendance(f.actorA, { sessionId: first.id, content: null, entries: [...entries(sheet.rows), outsider] }, at("2026-01-06")),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      attendance.saveAttendance(f.actorA, { sessionId: first.id, content: null, entries: entries(sheet.rows.slice(0, 1)) }, at("2026-01-06")),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("khóa sau 7 ngày; chỉ Admin mở khóa; mở khóa xong GV sửa được", async () => {
    const sheet = await attendance.getAttendanceSheet(f.actorA, first.id, at("2026-01-13"));
    const input = { sessionId: first.id, content: null, entries: entries(sheet.rows) };
    await expect(attendance.saveAttendance(f.actorA, input, at("2026-01-13"))).resolves.toBeDefined(); // ngày thứ 7: còn sửa được
    const locked = await attendance.getAttendanceSheet(f.actorA, first.id, at("2026-01-14"));
    expect(locked.locked).toBe(true);
    await expect(attendance.saveAttendance(f.actorA, input, at("2026-01-14"))).rejects.toMatchObject({ code: "CONFLICT" });
    // Admin cũng phải mở khóa trước (để có dấu vết trong nhật ký).
    await expect(attendance.saveAttendance(f.admin, input, at("2026-01-14"))).rejects.toMatchObject({ code: "CONFLICT" });

    await attendance.unlockAttendance(f.admin, first.id, at("2026-01-14"));
    await expect(attendance.saveAttendance(f.actorA, { ...input, entries: entries(sheet.rows, "absent") }, at("2026-01-14"))).resolves.toMatchObject({ changed: 2 });
    // Hết 24 giờ mở khóa thì khóa lại.
    await expect(attendance.saveAttendance(f.actorA, input, at("2026-01-16"))).rejects.toMatchObject({ code: "CONFLICT" });
    const unlockLogs = await db.select().from(auditLogs).where(eq(auditLogs.action, "attendance_unlocked"));
    expect(unlockLogs).toHaveLength(1);
  });

  it("không điểm danh buổi đã hủy hoặc chưa tới ngày; buổi đã điểm danh không hủy được", async () => {
    const sheet = await attendance.getAttendanceSheet(f.actorA, first.id, at("2026-01-06"));
    const input = { sessionId: first.id, content: null, entries: entries(sheet.rows) };
    await expect(attendance.saveAttendance(f.actorA, input, at("2026-01-05"))).rejects.toMatchObject({ code: "CONFLICT" });
    await svc.cancelSession(f.admin, { id: first.id, note: null });
    await expect(attendance.saveAttendance(f.actorA, input, at("2026-01-06"))).rejects.toMatchObject({ code: "CONFLICT" });
    await svc.restoreSession(f.admin, first.id);
    await attendance.saveAttendance(f.actorA, input, at("2026-01-06"));
    await expect(svc.cancelSession(f.admin, { id: first.id, note: null })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("Admin xóa buổi xếp sai, kể cả buổi đã điểm danh và ghi sao (xóa kèm); lớp đã đóng thì không; GV không xóa được", async () => {
    await expect(svc.deleteSession(f.actorA, later.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(svc.deleteSession(f.admin, later.id)).resolves.toEqual({ date: "2026-02-10", deletedAttendances: 0, deletedStarLogs: 0 });
    expect(await db.select().from(sessions).where(eq(sessions.id, later.id))).toEqual([]);
    const [log] = await db.select().from(auditLogs).where(eq(auditLogs.action, "session_deleted"));
    expect(log).toMatchObject({ userId: f.admin.userId, recordId: later.id, oldValue: { date: "2026-02-10" } });
    await expect(svc.deleteSession(f.admin, later.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Buổi đã điểm danh và có sao: xóa luôn điểm danh và sao của buổi.
    await db.insert(levels).values({ levelNo: 1, name: "Tân binh", minStars: 0, frameColor: "#b08d57" });
    const second = (await sessionsOf(f.classA.id))[1]!;
    const sheet = await attendance.getAttendanceSheet(f.actorA, first.id, at("2026-01-06"));
    await attendance.saveAttendance(f.actorA, { sessionId: first.id, content: null, entries: entries(sheet.rows) }, at("2026-01-06"));
    const studentId = sheet.rows[0]!.studentId;
    await db.insert(starLogs).values([
      { sessionId: first.id, studentId, stars: 3 },
      { sessionId: second.id, studentId, stars: 2 }, // buổi khác: giữ
    ]);
    await expect(svc.deleteSession(f.admin, first.id)).resolves.toMatchObject({ deletedAttendances: sheet.rows.length, deletedStarLogs: 1 });
    expect(await db.select().from(attendances).where(eq(attendances.sessionId, first.id))).toEqual([]);
    expect((await db.select().from(starLogs)).map((l) => l.stars)).toEqual([2]);

    await db.update(classes).set({ status: "closed" }).where(eq(classes.id, f.classA.id));
    await expect(svc.deleteSession(f.admin, second.id)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.select().from(sessions).where(eq(sessions.id, second.id))).toHaveLength(1);
  });

  it("buổi quá hạn: GV chỉ thấy buổi mình thực dạy, bỏ qua buổi đã hủy và đã điểm danh", async () => {
    const now = at("2026-01-21"); // đã qua 06/01, 13/01, 20/01
    expect((await attendance.listOverdueSessions(f.actorA, now)).map((s) => s.date)).toEqual(["2026-01-20", "2026-01-13", "2026-01-06"]);
    expect(await attendance.listOverdueSessions(f.actorB, now)).toEqual([]);
    const list = await sessionsOf(f.classA.id);
    await svc.cancelSession(f.admin, { id: list[1]!.id, note: null }); // 13/01
    await svc.setSubstitute(f.admin, { id: list[2]!.id, substituteTeacherId: f.teacherB.id }); // 20/01
    expect((await attendance.listOverdueSessions(f.actorA, now)).map((s) => s.date)).toEqual(["2026-01-06"]);
    expect((await attendance.listOverdueSessions(f.actorB, now)).map((s) => s.date)).toEqual(["2026-01-20"]);
    expect((await attendance.listOverdueSessions(f.actorA, now))[0]!.locked).toBe(true);
  });
});

describe("khung giờ của ca học", () => {
  it("một ca có nhiều khung giờ; không trùng số khung trong cùng ca; khác ca thì được", async () => {
    const afternoon = { name: "Ca chiều", defaultStart: "13:30", defaultEnd: "15:00" } as const;
    const first = await catalog.createTimeSlot(f.admin, { ...afternoon, frame: 1 });
    await catalog.createTimeSlot(f.admin, { name: "Ca chiều", frame: 2, defaultStart: "15:15", defaultEnd: "16:45" });
    await expect(catalog.createTimeSlot(f.admin, { name: "Ca chiều", frame: 2, defaultStart: "17:00", defaultEnd: "18:00" })).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { frame: "Ca chiều đã có Khung 2. Hãy chọn khung khác." },
    });
    // Sửa giữ nguyên số khung của chính nó thì được; đổi sang số khung đã có thì bị chặn.
    await catalog.updateTimeSlot(f.admin, first.id, { ...afternoon, frame: 1, defaultEnd: "14:50" });
    await expect(catalog.updateTimeSlot(f.admin, first.id, { ...afternoon, frame: 2 })).rejects.toMatchObject({ code: "VALIDATION" });
    // "Ca sáng" (đã có Khung 1) vẫn thêm Khung 2 được; người không có quyền Thêm thì không.
    await catalog.createTimeSlot(f.admin, { name: "Ca sáng", frame: 2, defaultStart: "10:00", defaultEnd: "11:30" });
    await expect(catalog.createTimeSlot(f.actorA, { name: "Ca tối", frame: 1, defaultStart: "10:00", defaultEnd: "11:30" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("lịch mẫu bị lặp trong cùng một lớp", () => {
  const input = (weekday: number, timeSlotId: string) => ({
    classId: f.classA.id,
    weekday,
    timeSlotId,
    roomId: null,
    teacherId: null,
    assistantTeacherId: null,
    startTime: null,
    endTime: null,
  });
  const now = at("2026-01-05");

  it("không cho thêm hoặc sửa thành hai dòng cùng Thứ + Ca + Khung giờ; khác khung hoặc khác thứ thì được", async () => {
    await svc.createTemplate(f.admin, input(2, morning.id), now);
    await expect(svc.createTemplate(f.admin, input(2, morning.id), now)).rejects.toMatchObject({
      code: "VALIDATION",
      fieldErrors: { timeSlotId: "Lớp đã có lịch mẫu vào Thứ Ba, ca và khung giờ này." },
    });
    await svc.createTemplate(f.admin, input(2, late.id), now);
    await svc.createTemplate(f.admin, input(4, morning.id), now);
    const rows = await db.select().from(scheduleTemplates).where(eq(scheduleTemplates.classId, f.classA.id));
    const thursday = rows.find((r) => r.weekday === 4)!;
    const fields = { weekday: 2, timeSlotId: morning.id, roomId: null, teacherId: null, assistantTeacherId: null, startTime: null, endTime: null };
    await expect(svc.updateTemplate(f.admin, { id: thursday.id, ...fields }, now)).rejects.toMatchObject({ code: "VALIDATION" });
    // Sửa chính nó (giữ nguyên thứ, khung) thì không tự báo trùng.
    await expect(svc.updateTemplate(f.admin, { id: thursday.id, ...fields, weekday: 4, teacherId: f.teacherA.id }, now)).resolves.toBeDefined();
  });

  it("dữ liệu cũ có hai dòng lặp: sinh buổi vẫn đủ số buổi, không báo trùng với chính lớp mình", async () => {
    await template(f.classA.id, 2, morning.id);
    await template(f.classA.id, 2, morning.id);
    const result = await svc.rebuildSchedule(f.admin, f.classA.id);
    expect(result.conflicts).toEqual([]);
    expect(result.created).toBe(13);
    const dates = (await sessionsOf(f.classA.id)).map((x) => x.date);
    expect(new Set(dates).size).toBe(13);
    // Trùng với LỚP KHÁC vẫn được báo.
    await template(f.classB.id, 2, morning.id);
    expect((await svc.rebuildSchedule(f.admin, f.classB.id)).conflicts.length).toBeGreaterThan(0);
  });
});
