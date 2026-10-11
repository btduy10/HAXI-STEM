import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { attendances, classes, scheduleTemplates, sessions, teachers, timeSlots } from "@/db/schema";
import * as svc from "@/server/services/sessions";
import { type Fixture, resetDb, seedFixture } from "./helpers";

// Lớp A: 05/01/2026 → 31/03/2026, khóa học 10 buổi.
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

const sessionsOf = (classId: string) =>
  db.select().from(sessions).where(eq(sessions.classId, classId)).orderBy(asc(sessions.date), asc(sessions.startTime));

describe("xếp lại lịch lớp theo lịch mẫu", () => {
  it("xếp đúng thứ, ca, GV của lịch mẫu cho mọi tuần trong thời gian của lớp; bỏ buổi chưa dạy sai lịch, giữ buổi đã dạy", async () => {
    // Lịch cũ sai: 12 buổi Thứ Hai ca sáng, chưa có GV; một buổi đã điểm danh.
    const [teacherC] = await db.insert(teachers).values({ code: "GVC", fullName: "GV C" }).returning();
    const wrong = Array.from({ length: 12 }, (_, i) => {
      const day = new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString().slice(0, 10);
      return { classId: f.classA.id, date: day, startTime: "08:00", endTime: "09:30", timeSlotId: morning.id };
    });
    const inserted = await db.insert(sessions).values(wrong).returning();
    await db.insert(attendances).values({ sessionId: inserted[0]!.id, studentId: f.students[0]!.id, status: "present" });
    await db.update(sessions).set({ status: "done" }).where(eq(sessions.id, inserted[0]!.id));

    // Lịch mẫu đúng: Thứ Tư ca tối, GV C dạy chính, GV A trợ giảng.
    await db.insert(scheduleTemplates).values({ classId: f.classA.id, weekday: 3, timeSlotId: evening.id, teacherId: teacherC!.id, assistantTeacherId: f.teacherA.id });
    const result = await svc.rebuildSchedule(f.admin, f.classA.id);

    // Lớp học 06/01 – 31/03: buổi đầu vào ngày khai giảng, rồi mọi Thứ Tư đến 25/03 = 13 buổi mới, cộng 1 buổi đã dạy.
    expect(result).toMatchObject({ removed: 11, created: 13, scheduled: 14 });
    expect(result).not.toHaveProperty("courseSessions");
    const list = await sessionsOf(f.classA.id);
    expect(list).toHaveLength(14);
    expect(list.at(-1)!.date).toBe("2026-03-25");
    expect(list[0]!.id).toBe(inserted[0]!.id); // buổi đã dạy giữ nguyên
    const rebuilt = list.slice(1);
    // Buổi 1 vào đúng ngày khai giảng 06/01 (Thứ Ba) với ca, GV của lịch mẫu; các buổi sau vào Thứ Tư.
    expect(rebuilt[0]!.date).toBe("2026-01-06");
    expect(rebuilt.slice(1).every((s) => new Date(`${s.date}T00:00:00Z`).getUTCDay() === 3)).toBe(true);
    expect(rebuilt.every((s) => s.startTime === "18:00:00" && s.timeSlotId === evening.id)).toBe(true);
    expect(rebuilt.every((s) => s.teacherId === teacherC!.id && s.assistantTeacherId === f.teacherA.id)).toBe(true);

    // Trang Lớp học hiển thị tình trạng lịch: số buổi đã xếp, buổi đầu, đã dạy 1, buổi sắp tới kèm GV.
    const overview = await svc.classScheduleOverview(f.admin, f.classA.id, "2026-01-08");
    expect(overview).toMatchObject({ scheduled: 14, done: 1, missingTeacher: 1 });
    expect(overview).not.toHaveProperty("courseSessions");
    expect(overview.first!.date).toBe("2026-01-05");
    expect(overview.upcoming.map((s) => [s.date, s.teacherName, s.assistantName])[0]).toEqual(["2026-01-14", "GV C", "Giáo viên A"]);

    // Bấm lại: vẫn đúng 14 buổi, ngày kết thúc của lớp không bị lùi.
    await svc.rebuildSchedule(f.admin, f.classA.id);
    expect(await sessionsOf(f.classA.id)).toHaveLength(14);
    expect((await db.select().from(classes).where(eq(classes.id, f.classA.id)))[0]!.endDate).toBe("2026-03-31");
    await expect(svc.rebuildSchedule(f.actorA, f.classA.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
