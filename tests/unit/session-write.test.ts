import { describe, expect, it } from "vitest";
import { CLASS_CLOSED_MESSAGE, TIMETABLE_ONLY_MESSAGE, type WriteTarget, sessionWriteBlock } from "@/domain/session-write";

const now = new Date("2026-03-20T03:00:00Z");
const context = { today: "2026-03-20", now, lockDays: 7 };
const base: WriteTarget = { date: "2026-03-18", status: "planned", attendanceUnlockedUntil: null, classStatus: "open", timetableOnly: false };
const block = (patch: Partial<WriteTarget>, work: "attendance" | "stars" = "attendance") => sessionWriteBlock({ ...base, ...patch }, work, context);

describe("buổi học còn điểm danh / ghi sao được không", () => {
  it("buổi bình thường trong hạn: ghi được cả hai việc", () => {
    expect(block({})).toBeNull();
    expect(block({}, "stars")).toBeNull();
    expect(block({ date: "2026-03-20", status: "done" })).toBeNull();
  });

  it("từng lý do, đúng câu báo cho từng việc", () => {
    expect(block({ timetableOnly: true })).toEqual({ code: "timetable-only", message: TIMETABLE_ONLY_MESSAGE });
    expect(block({ status: "cancelled" })).toEqual({ code: "cancelled", message: "Buổi đã hủy nên không cần điểm danh." });
    expect(block({ status: "cancelled" }, "stars")).toEqual({ code: "cancelled", message: "Buổi đã hủy nên không ghi sao được." });
    expect(block({ classStatus: "closed" }, "stars")).toEqual({ code: "class-closed", message: CLASS_CLOSED_MESSAGE });
    expect(block({ date: "2026-03-21" })).toEqual({ code: "not-yet", message: "Chưa đến ngày học." });
    expect(block({ date: "2026-03-12" })).toEqual({
      code: "locked",
      message: "Đã quá 7 ngày kể từ buổi học nên điểm danh bị khóa. Liên hệ quản trị viên để mở khóa.",
    });
  });

  it("khóa điểm danh: N ngày tính cả ngày cuối, Admin mở khóa còn hiệu lực thì ghi được; ghi sao không bị khóa theo hạn", () => {
    expect(block({ date: "2026-03-13" })).toBeNull();
    expect(block({ date: "2026-03-12" })?.code).toBe("locked");
    expect(block({ date: "2026-03-12", attendanceUnlockedUntil: new Date("2026-03-20T05:00:00Z") })).toBeNull();
    expect(block({ date: "2026-03-12", attendanceUnlockedUntil: new Date("2026-03-20T02:00:00Z") })?.code).toBe("locked");
    expect(block({ date: "2026-01-02" }, "stars")).toBeNull();
  });

  it("nhiều lý do cùng đúng: báo theo thứ tự lớp chỉ hiện trên TKB, đã hủy, lớp đã đóng, chưa đến ngày, quá hạn", () => {
    const all = { timetableOnly: true, status: "cancelled", classStatus: "closed", date: "2026-03-25" };
    expect(block(all)?.code).toBe("timetable-only");
    expect(block({ ...all, timetableOnly: false })?.code).toBe("cancelled");
    expect(block({ ...all, timetableOnly: false, status: "planned" })?.code).toBe("class-closed");
    expect(block({ ...all, timetableOnly: false, status: "planned", classStatus: "open" })?.code).toBe("not-yet");
    // Lớp đã đóng thì mở khóa điểm danh cũng không giúp gì: báo lớp đã đóng thay vì quá hạn.
    expect(block({ classStatus: "closed", date: "2026-01-02" })?.code).toBe("class-closed");
  });
});
