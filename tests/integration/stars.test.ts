import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { appSettings, attendances, auditLogs, sessions, starCriteria, starLogs, students } from "@/db/schema";
import { DEFAULT_PERMISSIONS } from "@/lib/permissions";
import * as stars from "@/server/services/stars";
import { type Fixture, resetDb, seedFixture } from "./helpers";

let f: Fixture;
let sessionA: typeof sessions.$inferSelect;
let sessionA2: typeof sessions.$inferSelect;
let crit: Record<string, string>;
const now = new Date("2026-01-13T05:00:00Z");

beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  const criteria = await db
    .insert(starCriteria)
    .values([
      { name: "+20", stars: 20, type: "reward" },
      { name: "+3", stars: 3, type: "reward" },
      { name: "-1", stars: -1, type: "penalty" },
      { name: "-2", stars: -2, type: "penalty" },
      { name: "-3", stars: -3, type: "penalty" },
      { name: "ngừng", stars: 1, type: "reward", active: false },
    ])
    .returning();
  crit = Object.fromEntries(criteria.map((c) => [c.name, c.id]));
  [sessionA, sessionA2] = (await db
    .insert(sessions)
    .values([
      { classId: f.classA.id, date: "2026-01-06", startTime: "08:00", endTime: "09:30", teacherId: f.teacherA.id },
      { classId: f.classA.id, date: "2026-01-13", startTime: "08:00", endTime: "09:30", teacherId: f.teacherA.id },
    ])
    .returning()) as [typeof sessions.$inferSelect, typeof sessions.$inferSelect];
});

const a1 = () => f.students[0]!.id;
const a2 = () => f.students[1]!.id;
const give = (criteria: string, studentIds: string[], actor = f.actorA, session = sessionA) =>
  stars.awardStars(actor, { sessionId: session.id, criteriaId: crit[criteria]!, studentIds, note: null }, now);
const total = async (studentId: string) => (await stars.starTotalsOf(db, [studentId])).get(studentId)!;

describe("ghi sao", () => {
  it("ghi cho một em, một nhóm, cả lớp; tổng tính khi truy vấn", async () => {
    expect(await give("+3", [a1()])).toEqual({ count: 1, stars: 3 });
    expect((await give("+3", [a1(), a2()])).count).toBe(2);
    expect(await total(a1())).toBe(6);
    expect(await total(a2())).toBe(3);
    const board = await stars.getSessionStarBoard(f.actorA, sessionA.id);
    expect(board.students.map((s) => [s.code, s.sessionStars, s.total])).toEqual([["A1", 6, 6], ["A2", 3, 3]]);
    expect(board.logs).toHaveLength(3);
    expect(board.criteria.map((c) => c.name)).not.toContain("ngừng");
  });

  it("tổng sao không bao giờ âm", async () => {
    await give("-3", [a1()]);
    expect(await total(a1())).toBe(0);
    const [{ raw }] = (await db.execute(sql`select sum(stars)::int as raw from star_logs`)) as unknown as [{ raw: number }];
    expect(raw).toBe(-3); // sổ cái vẫn lưu đủ, chỉ tổng hiển thị bị chặn dưới 0
  });

  it("chỉ ghi cho học viên của buổi; từ chối tiêu chí ngừng dùng, buổi hủy, buổi chưa tới", async () => {
    await expect(give("+3", [a1(), f.students[2]!.id])).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.select().from(starLogs)).toEqual([]); // cả nhóm không được ghi
    await expect(give("ngừng", [a1()])).rejects.toMatchObject({ code: "VALIDATION" });
    const [future] = await db.insert(sessions).values({ classId: f.classA.id, date: "2026-02-03", startTime: "08:00", endTime: "09:30" }).returning();
    await expect(give("+3", [a1()], f.actorA, future!)).rejects.toMatchObject({ code: "CONFLICT" });
    await db.update(sessions).set({ status: "cancelled" }).where(eq(sessions.id, sessionA.id));
    await expect(give("+3", [a1()])).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("GV lớp khác không ghi, không xem, không hoàn tác được sao của lớp này", async () => {
    await expect(give("+3", [a1()], f.actorB)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(stars.getSessionStarBoard(f.actorB, sessionA.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await give("+3", [a1()]);
    const [log] = await db.select().from(starLogs);
    await expect(stars.undoStarLog(f.actorB, log!.id, now)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(stars.getStudentStarProfile(f.actorB, a1())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(stars.listClassStars(f.actorB, f.classA.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await stars.listClassStars(f.actorA, f.classA.id)).map((s) => [s.code, s.total])).toEqual([["A1", 3], ["A2", 0]]);
    expect(await total(a1())).toBe(3);
  });
});

describe("hồ sơ học viên", () => {
  it("hiện buổi đã học kèm sao từng buổi; GV chỉ được xếp dạy bên TKB cũng xem được, GV khác thì không", async () => {
    await db.insert(attendances).values([
      { sessionId: sessionA.id, studentId: a1(), status: "present" },
      { sessionId: sessionA2.id, studentId: a1(), status: "absent" },
    ]);
    await give("+3", [a1()]);
    const profile = await stars.getStudentStarProfile(f.actorA, a1());
    expect(profile.attendance.map((a) => [a.date, a.status, a.stars])).toEqual([
      ["2026-01-13", "absent", 0],
      ["2026-01-06", "present", 3],
    ]);
    expect(profile.gifts).toEqual([]);
    // Hồ sơ không còn danh sách từng lần ghi sao (sao hiện theo buổi học).
    expect(Object.keys(profile).sort()).toEqual(["attendance", "gifts", "student"]);

    await expect(stars.getStudentStarProfile(f.actorB, a1())).rejects.toMatchObject({ code: "NOT_FOUND" });
    // GV B được xếp dạy một buổi của lớp A → xem được hồ sơ học viên lớp A.
    await db.insert(sessions).values({ classId: f.classA.id, date: "2026-01-20", startTime: "08:00", endTime: "09:30", teacherId: f.teacherB.id });
    expect((await stars.getStudentStarProfile(f.actorB, a1())).attendance).toHaveLength(2);
  });

  it("GV dạy thay hôm nay xem được hồ sơ học viên của buổi đó; hết hôm nay thì không", async () => {
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
    await db.insert(sessions).values({ classId: f.classA.id, date, startTime: "20:00", endTime: "21:00", teacherId: f.teacherA.id, substituteTeacherId: f.teacherB.id });
    await expect(stars.getStudentStarProfile(f.actorB, a1())).resolves.toBeDefined();
    await db.update(sessions).set({ date: "2026-01-20" }).where(eq(sessions.substituteTeacherId, f.teacherB.id));
    await expect(stars.getStudentStarProfile(f.actorB, a1())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("giới hạn trừ sao mỗi buổi (mặc định 3)", () => {
  it("chặn khi tổng trừ trong buổi vượt giới hạn; buổi khác tính riêng", async () => {
    await give("-2", [a1()]);
    await expect(give("-2", [a1()])).rejects.toMatchObject({ code: "CONFLICT" });
    await give("-1", [a1()]);
    await expect(give("-1", [a1()])).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(give("-3", [a1()], f.actorA, sessionA2)).resolves.toBeDefined();
    // Thưởng không bị ảnh hưởng bởi giới hạn trừ.
    await expect(give("+3", [a1()])).resolves.toBeDefined();
  });

  it("ghi theo nhóm: một em vượt giới hạn thì không em nào bị trừ", async () => {
    await give("-3", [a1()]);
    await expect(give("-1", [a1(), a2()])).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("Học viên A1") });
    expect((await db.select().from(starLogs)).length).toBe(1);
  });

  it("hoàn tác lần trừ thì được trừ lại; giới hạn lấy từ cấu hình", async () => {
    await give("-3", [a1()]);
    const [log] = await db.select().from(starLogs);
    await stars.undoStarLog(f.actorA, log!.id, now);
    await expect(give("-3", [a1()])).resolves.toBeDefined();
    await db.insert(appSettings).values({ key: "max_deduction_per_session", value: 5 });
    await expect(give("-2", [a1()])).resolves.toBeDefined();
    await expect(give("-1", [a1()])).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("hoàn tác và sổ cái", () => {
  it("ghi sao không còn đổi avatar hay báo lên/tụt cấp", async () => {
    await give("+3", [a1()]);
    expect(await give("+20", [a1()])).toEqual({ count: 1, stars: 20 });
    expect(await give("-3", [a1()])).toEqual({ count: 1, stars: -3 });
    const [student] = await db.select().from(students).where(eq(students.id, a1()));
    expect(student!.currentAvatarId).toBeNull();
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "avatar_auto_switched"))).toEqual([]);
  });

  it("hoàn tác: ghi bản đảo, không xóa; chỉ một lần", async () => {
    await give("+3", [a1()]);
    await give("+20", [a1()]);
    const logs = await db.select().from(starLogs);
    const big = logs.find((l) => l.stars === 20)!;

    expect(await stars.undoStarLog(f.actorA, big.id, now)).toEqual({ count: 1, stars: -20 });
    expect(await total(a1())).toBe(3);
    const after = await db.select().from(starLogs);
    expect(after).toHaveLength(3);
    const reversal = after.find((l) => l.reversesLogId === big.id)!;
    expect(reversal.stars).toBe(-20);

    await expect(stars.undoStarLog(f.actorA, big.id, now)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(stars.undoStarLog(f.actorA, reversal.id, now)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.select().from(starLogs)).toHaveLength(3);
  });

  it("sổ cái không sửa, không xóa được ở mức CSDL", async () => {
    await give("+3", [a1()]);
    await expect(db.update(starLogs).set({ stars: 999 })).rejects.toThrow();
    await expect(db.delete(starLogs)).rejects.toThrow();
    expect(await total(a1())).toBe(3);
  });
});

describe("Admin quản lý tiêu chí sao", () => {
  it("GV bị từ chối; không được tick Xem ở menu Sao thì không xem được sổ cái", async () => {
    const denied = { code: "FORBIDDEN" };
    await expect(stars.createCriteria(f.actorA, { name: "x", stars: 10, active: true, type: "reward" })).rejects.toMatchObject(denied);
    const noStars = { ...f.actorA, perms: { scope: "own" as const, menus: { ...DEFAULT_PERMISSIONS.teacher.menus, stars: { view: false, add: false, edit: false } } } };
    await expect(stars.listRecentStarLogs(noStars)).rejects.toMatchObject(denied);
    await expect(stars.getSessionStarBoard(noStars, sessionA.id)).rejects.toMatchObject(denied);
  });
});
