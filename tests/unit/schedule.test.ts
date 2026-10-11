import { describe, expect, it } from "vitest";
import { findConflicts, isAttendanceLocked, isEnrolledOn, planSessions, timesOverlap } from "@/domain/schedule";
import { addDays, addMonths, endOfMonth, isoWeekday, nextWeekRange, parseIsoDate, startOfWeek } from "@/lib/dates";

describe("ngày tháng", () => {
  it("tính thứ, tuần, tháng không phụ thuộc múi giờ", () => {
    expect(isoWeekday("2026-01-05")).toBe(1); // Thứ Hai
    expect(isoWeekday("2026-01-11")).toBe(7); // Chủ nhật
    expect(startOfWeek("2026-01-11")).toBe("2026-01-05");
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-01");
    expect(endOfMonth("2028-02-10")).toBe("2028-02-29");
    expect(parseIsoDate("2026-02-30", "x")).toBe("x");
    expect(parseIsoDate("'; drop table", "x")).toBe("x");
  });

  it("tuần sau là Thứ Hai đến Chủ nhật của tuần kế tiếp, dù hôm nay là ngày nào trong tuần", () => {
    const next = { from: "2026-02-09", to: "2026-02-15" };
    expect(nextWeekRange("2026-02-02")).toEqual(next); // Thứ Hai
    expect(nextWeekRange("2026-02-04")).toEqual(next); // Thứ Tư
    expect(nextWeekRange("2026-02-08")).toEqual(next); // Chủ nhật vẫn thuộc tuần này
    expect(nextWeekRange("2026-02-09")).toEqual({ from: "2026-02-16", to: "2026-02-22" });
    // Qua tháng, qua năm.
    expect(nextWeekRange("2026-12-30")).toEqual({ from: "2027-01-04", to: "2027-01-10" });
  });
});

describe("chồng lấn giờ", () => {
  it("so theo khoảng giờ thực, chạm mép không tính là trùng", () => {
    expect(timesOverlap("08:00", "09:30", "09:00", "10:00")).toBe(true);
    expect(timesOverlap("08:00", "09:30", "09:30", "11:00")).toBe(false);
    expect(timesOverlap("08:00:00", "09:30:00", "08:15", "08:45")).toBe(true);
    expect(timesOverlap("14:00", "15:30", "08:00", "09:30")).toBe(false);
  });

  it("phát hiện trùng GV và trùng phòng, bỏ qua chính nó và ngày khác", () => {
    const others = [
      { id: "s1", date: "2026-01-06", startTime: "08:00", endTime: "09:30", timeSlotId: "k1", roomId: "r1", teacherIds: ["t1"], label: "A" },
      { id: "s2", date: "2026-01-07", startTime: "08:00", endTime: "09:30", timeSlotId: "k1", roomId: "r1", teacherIds: ["t1"], label: "A" },
    ];
    const base = { date: "2026-01-06", startTime: "08:00", endTime: "09:30", timeSlotId: "k1" };
    expect(findConflicts({ ...base, roomId: "r1", teacherIds: ["t2"] }, others).map((c) => c.kind)).toEqual(["room"]);
    expect(findConflicts({ ...base, roomId: "r2", teacherIds: ["t1"] }, others).map((c) => c.kind)).toEqual(["teacher"]);
    expect(findConflicts({ ...base, roomId: "r1", teacherIds: ["t1"] }, others)).toHaveLength(2);
    expect(findConflicts({ ...base, id: "s1", roomId: "r1", teacherIds: ["t1"] }, others)).toEqual([]);
    expect(findConflicts({ ...base, roomId: null, teacherIds: [] }, others)).toEqual([]);
    // Trợ giảng cũng bị kiểm tra trùng: người này đang trợ giảng buổi khác cùng giờ, hoặc đang dạy chính.
    const withAssistant = [{ ...others[0]!, id: "s3", teacherIds: ["t9", "t5"] }];
    expect(findConflicts({ ...base, roomId: "r2", teacherIds: ["t1", "t5"] }, withAssistant).map((c) => c.kind)).toEqual(["teacher"]);
    expect(findConflicts({ ...base, roomId: "r2", teacherIds: ["t7"] }, withAssistant)).toEqual([]);
  });

  it("chỉ trùng khi cùng ngày, cùng Ca + Khung giờ; khác khung thì không trùng dù giờ chồng nhau; buổi giờ tự do so theo giờ", () => {
    const others = [{ id: "s1", date: "2026-01-06", startTime: "19:00", endTime: "20:30", timeSlotId: "k1", roomId: "r1", teacherIds: ["t1"], label: "A" }];
    const same = { date: "2026-01-06", startTime: "19:00", endTime: "20:30", roomId: "r1", teacherIds: ["t1"] };
    // Khác khung giờ: GV dạy nhiều ca, nhiều khung trong ngày là bình thường.
    expect(findConflicts({ ...same, timeSlotId: "k2" }, others)).toEqual([]);
    // Cùng khung giờ: trùng cả GV lẫn phòng, kể cả khi giờ riêng của buổi đã sửa khác đi.
    expect(findConflicts({ ...same, timeSlotId: "k1", startTime: "17:00", endTime: "18:00" }, others).map((c) => [c.kind, c.sameSlot])).toEqual([
      ["teacher", true],
      ["room", true],
    ]);
    // Buổi bù giờ tự do (không gắn ca): so theo khoảng giờ thực tế.
    expect(findConflicts({ ...same, timeSlotId: null, startTime: "20:00", endTime: "21:00" }, others).map((c) => [c.kind, c.sameSlot])).toEqual([
      ["teacher", false],
      ["room", false],
    ]);
    expect(findConflicts({ ...same, timeSlotId: null, startTime: "20:30", endTime: "21:30" }, others)).toEqual([]);
  });
});

describe("sinh buổi học", () => {
  const template = { id: "tp1", weekday: 2, timeSlotId: "slot", slotStart: "18:00:00", slotEnd: "19:30:00", startTime: null, endTime: null, roomId: null, teacherId: null, assistantTeacherId: null };

  it("sinh đúng thứ trong khoảng ngày, bỏ ngày nghỉ, sao chép giờ từ ca", () => {
    const planned = planSessions({
      startDate: "2026-01-05",
      endDate: "2026-01-31",
      templates: [template],
      holidays: new Set(["2026-01-13"]),
      defaultRoomId: "room",
      defaultTeacherId: "teacher",
    });
    expect(planned.map((p) => p.date)).toEqual(["2026-01-06", "2026-01-20", "2026-01-27"]);
    expect(planned[0]).toMatchObject({ startTime: "18:00", endTime: "19:30", roomId: "room", teacherId: "teacher", templateId: "tp1" });
  });

  it("một lớp nhiều dòng/tuần; dòng có giờ, phòng, GV riêng thì dùng giá trị riêng", () => {
    const planned = planSessions({
      startDate: "2026-01-05",
      endDate: "2026-01-11",
      templates: [template, { ...template, id: "tp2", weekday: 6, startTime: "09:00", endTime: "11:00", roomId: "r2", teacherId: "t2" }],
      holidays: new Set(),
      defaultRoomId: "room",
      defaultTeacherId: "teacher",
    });
    expect(planned).toHaveLength(2);
    expect(planned[1]).toMatchObject({ date: "2026-01-10", startTime: "09:00", endTime: "11:00", roomId: "r2", teacherId: "t2" });
  });
});

describe("khóa điểm danh và danh sách theo ngày ghi danh", () => {
  it("khóa sau N ngày, mở khóa của Admin còn hạn thì sửa được", () => {
    const now = new Date("2026-01-20T03:00:00Z");
    const base = { sessionDate: "2026-01-01", lockDays: 7, unlockedUntil: null, now };
    expect(isAttendanceLocked({ ...base, today: "2026-01-08" })).toBe(false);
    expect(isAttendanceLocked({ ...base, today: "2026-01-09" })).toBe(true);
    expect(isAttendanceLocked({ ...base, today: "2026-01-20", unlockedUntil: new Date("2026-01-20T04:00:00Z") })).toBe(false);
    expect(isAttendanceLocked({ ...base, today: "2026-01-20", unlockedUntil: new Date("2026-01-20T02:00:00Z") })).toBe(true);
  });

  it("học viên chỉ thuộc buổi nằm trong thời gian ghi danh", () => {
    const e = { joinedAt: "2026-01-10", leftAt: "2026-02-01" };
    expect(isEnrolledOn(e, "2026-01-09")).toBe(false);
    expect(isEnrolledOn(e, "2026-01-10")).toBe(true);
    expect(isEnrolledOn(e, "2026-01-31")).toBe(true);
    expect(isEnrolledOn(e, "2026-02-01")).toBe(false);
    expect(isEnrolledOn({ joinedAt: "2026-01-10", leftAt: null }, "2027-01-01")).toBe(true);
  });

  it("buổi đầu vào đúng ngày khai giảng dù không trùng thứ của lịch mẫu", () => {
    const base = { startDate: "2026-10-10", endDate: "2026-10-31", holidays: new Set<string>(), defaultRoomId: "room", defaultTeacherId: "t" };
    const thursday = { id: "tp", weekday: 4, timeSlotId: "slot", slotStart: "18:00:00", slotEnd: "19:30:00", startTime: null, endTime: null, roomId: null, teacherId: null, assistantTeacherId: null };
    const dates = (opts: { firstOnStartDate?: boolean; holidays?: Set<string> }) =>
      planSessions({ ...base, ...opts, templates: [thursday] }).map((p) => p.date);
    // 10/10/2026 là Thứ Bảy: buổi 1 vào 10/10 (ca của lịch mẫu), sau đó các Thứ Năm.
    expect(dates({ firstOnStartDate: true })).toEqual(["2026-10-10", "2026-10-15", "2026-10-22", "2026-10-29"]);
    expect(dates({})).toEqual(["2026-10-15", "2026-10-22", "2026-10-29"]);
    expect(dates({ firstOnStartDate: true, holidays: new Set(["2026-10-10"]) })[0]).toBe("2026-10-15");
  });
});
