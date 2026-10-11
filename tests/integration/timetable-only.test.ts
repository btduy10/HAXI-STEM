import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { classes, scheduleTemplates, sessions, starCriteria, timeSlots } from "@/db/schema";
import * as attendance from "@/server/services/attendance";
import * as classSvc from "@/server/services/classes";
import { adminOverview } from "@/server/services/dashboard";
import { timetableDoc } from "@/server/services/reports";
import * as svc from "@/server/services/sessions";
import * as stars from "@/server/services/stars";
import * as summaries from "@/server/services/summaries";
import { teacherTimesheet } from "@/server/services/timesheet";
import { listClassFees, setClassFee } from "@/server/services/tuition";
import { type Fixture, resetDb, seedFixture } from "./helpers";

// Lớp "Mượn phòng" chỉ hiển thị trên Thời khóa biểu: Thứ Ba, Ca sáng, phòng Lab (cùng phòng với lớp A và B).
let f: Fixture;
let morning: typeof timeSlots.$inferSelect;
let lend: typeof classes.$inferSelect;
const range = { from: "2026-01-05", to: "2026-01-11" };
const now = new Date("2026-01-14T05:00:00Z"); // 12:00 ngày 14/01 giờ Việt Nam: buổi 06/01 và 13/01 đã qua

beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  [morning] = (await db.insert(timeSlots).values({ name: "Ca sáng", frame: 1, defaultStart: "08:00", defaultEnd: "09:30" }).returning()) as [
    typeof timeSlots.$inferSelect,
  ];
  // Mã lớp do máy chủ tự cấp theo năm tạo: lớp đầu tiên của năm 2026 là RB2601.
  lend = await classSvc.createClass(
    f.admin,
    { name: "Mượn phòng", defaultRoomId: f.room.id, startDate: "2026-01-06", endDate: "2026-03-31", maxSize: 1, timetableOnly: true },
    new Date("2026-01-05T05:00:00Z"),
  );
  await db.insert(scheduleTemplates).values({ classId: lend.id, weekday: 2, timeSlotId: morning.id, teacherId: f.teacherA.id });
  await svc.generateSessions(f.admin, lend.id);
});

const firstSession = async () => (await db.select().from(sessions).where(eq(sessions.classId, lend.id)).orderBy(sessions.date))[0]!;

describe("lớp chỉ hiển thị trên Thời khóa biểu", () => {
  it("chỉ có trên Thời khóa biểu: không có trong danh sách lớp, buổi học, buổi quá hạn, học phí, chấm công, số lớp đang mở, tệp xuất", async () => {
    expect((await classSvc.listClasses(f.admin)).map((c) => c.code)).toEqual(["A", "B"]);
    expect((await classSvc.listClasses(f.admin, { includeTimetableOnly: true })).map((c) => c.code).sort()).toEqual(["A", "B", "RB2601"]);

    expect(await svc.listSessions(f.admin, range)).toEqual([]);
    const shown = await svc.listSessions(f.admin, { ...range, includeTimetableOnly: true });
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ classCode: "RB2601", date: "2026-01-06", timetableOnly: true, roomId: f.room.id });
    // Giáo viên được xếp vào buổi vẫn thấy buổi trên Thời khóa biểu của mình, nhưng không ở nơi khác.
    expect(await svc.listSessions(f.actorA, { ...range, personal: true, includeTimetableOnly: true })).toHaveLength(1);
    expect(await svc.listSessions(f.actorA, { ...range, personal: true })).toEqual([]);
    expect((await classSvc.listClasses(f.actorA)).map((c) => c.code)).toEqual(["A"]);

    expect(await attendance.listOverdueSessions(f.admin, now)).toEqual([]);
    expect(await attendance.listOverdueSessions(f.actorA, now)).toEqual([]);
    expect((await listClassFees(f.admin)).map((c) => c.code).sort()).toEqual(["A", "B"]);
    expect((await teacherTimesheet(f.admin, { from: "2026-01-01", to: "2026-01-31" }, now)).rows).toEqual([]);
    expect((await adminOverview(f.admin)).openClasses).toBe(2);
    expect((await timetableDoc(f.admin, range)).sections[0]!.rows).toEqual([]);
  });

  it("máy chủ từ chối điểm danh, ghi sao, ghi danh, học phí, đóng lớp và báo cáo của lớp này", async () => {
    const session = await firstSession();
    const conflict = { code: "CONFLICT", message: expect.stringContaining("chỉ hiển thị trên Thời khóa biểu") };
    await expect(attendance.getAttendanceSheet(f.admin, session.id, now)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      attendance.saveAttendance(f.admin, { sessionId: session.id, content: null, entries: [{ studentId: f.students[4]!.id, status: "present", note: null }] }, now),
    ).rejects.toMatchObject(conflict);
    await expect(stars.getSessionStarBoard(f.admin, session.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const [criteria] = await db.insert(starCriteria).values({ name: "Tích cực", stars: 1, type: "reward" }).returning();
    await expect(
      stars.awardStars(f.admin, { sessionId: session.id, criteriaId: criteria!.id, studentIds: [f.students[4]!.id], note: null }, now),
    ).rejects.toMatchObject(conflict);
    await expect(classSvc.enrollStudent(f.admin, { classId: lend.id, studentId: f.students[4]!.id, joinedAt: "2026-01-06" })).rejects.toMatchObject(conflict);
    await expect(setClassFee(f.admin, { classId: lend.id, tuitionFee: 1_000_000 })).rejects.toMatchObject(conflict);
    await expect(summaries.closeClass(f.admin, lend.id, now)).rejects.toMatchObject(conflict);
    await expect(summaries.getClassReport(f.admin, lend.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Không có gì được ghi: buổi vẫn ở trạng thái đã xếp.
    expect((await firstSession()).status).toBe("planned");
  });

  it("vẫn kiểm tra trùng phòng với lớp thường khi sinh buổi", async () => {
    // Lớp A cùng Thứ Ba, cùng ca, cùng phòng Lab với lớp mượn phòng.
    await db.insert(scheduleTemplates).values({ classId: f.classA.id, weekday: 2, timeSlotId: morning.id, teacherId: f.teacherB.id });
    const result = await svc.generateSessions(f.admin, f.classA.id);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result.conflicts[0]!.reason).toContain("Phòng");
    const taken = new Set((await db.select().from(sessions).where(eq(sessions.classId, lend.id))).map((s) => s.date));
    const ofA = await db.select().from(sessions).where(eq(sessions.classId, f.classA.id));
    expect(ofA.some((s) => taken.has(s.date))).toBe(false);
  });

  it("chỉ bật được cho lớp chưa có dữ liệu học viên; tắt thì luôn được", async () => {
    const input = (cls: typeof classes.$inferSelect, timetableOnly: boolean) => ({
      name: cls.name,
      defaultRoomId: cls.defaultRoomId,
      startDate: cls.startDate,
      endDate: cls.endDate,
      maxSize: cls.maxSize,
      timetableOnly,
    });
    // Lớp A đang có 2 học viên ghi danh.
    await expect(classSvc.updateClass(f.admin, f.classA.id, input(f.classA, true))).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("2 lượt ghi danh"),
    });
    expect((await db.select().from(classes).where(eq(classes.id, f.classA.id)))[0]!.timetableOnly).toBe(false);
    // Sửa thông tin khác của lớp đang là "chỉ Thời khóa biểu" không bị chặn.
    await classSvc.updateClass(f.admin, lend.id, { ...input(lend, true), name: "Cho mượn phòng Lab" });
    await classSvc.updateClass(f.admin, lend.id, input(lend, false));
    expect((await classSvc.listClasses(f.admin)).map((c) => c.code).sort()).toEqual(["A", "B", "RB2601"]);
    expect(await svc.listSessions(f.admin, range)).toHaveLength(1);
  });
});
