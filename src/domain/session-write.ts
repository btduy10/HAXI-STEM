import { isAttendanceLocked } from "./schedule";

/** Việc ghi vào một buổi học. */
export type SessionWork = "attendance" | "stars";

export type WriteBlockCode = "timetable-only" | "cancelled" | "class-closed" | "not-yet" | "locked";
export type WriteBlock = { code: WriteBlockCode; message: string };

/** Buổi học cùng trạng thái của lớp, đủ để biết buổi còn ghi được không. */
export type WriteTarget = {
  date: string;
  status: string;
  attendanceUnlockedUntil: Date | null;
  classStatus: string;
  timetableOnly: boolean;
};

export const TIMETABLE_ONLY_MESSAGE = "Lớp này chỉ hiển thị trên Thời khóa biểu nên không dùng được chức năng này.";
export const CLASS_CLOSED_MESSAGE = "Lớp đã đóng và đã chốt tổng kết nên không thay đổi được nữa.";

const CANCELLED_MESSAGE: Record<SessionWork, string> = {
  attendance: "Buổi đã hủy nên không cần điểm danh.",
  stars: "Buổi đã hủy nên không ghi sao được.",
};

/**
 * Lý do buổi học không điểm danh hay ghi sao được, hoặc null khi được ghi. Một nơi duy nhất cho các luật này: máy chủ dùng để
 * chặn khi lưu, các trang dùng để báo trước. Nhiều lý do cùng đúng thì báo lý do đứng trước theo thứ tự: lớp chỉ hiện trên
 * Thời khóa biểu, buổi đã hủy, lớp đã đóng, chưa đến ngày học, quá hạn khóa điểm danh (chỉ điểm danh; Admin mở khóa được).
 */
export function sessionWriteBlock(
  target: WriteTarget,
  work: SessionWork,
  context: { today: string; now: Date; lockDays: number },
): WriteBlock | null {
  if (target.timetableOnly) return { code: "timetable-only", message: TIMETABLE_ONLY_MESSAGE };
  if (target.status === "cancelled") return { code: "cancelled", message: CANCELLED_MESSAGE[work] };
  if (target.classStatus !== "open") return { code: "class-closed", message: CLASS_CLOSED_MESSAGE };
  if (target.date > context.today) return { code: "not-yet", message: "Chưa đến ngày học." };
  if (
    work === "attendance" &&
    isAttendanceLocked({ sessionDate: target.date, today: context.today, lockDays: context.lockDays, unlockedUntil: target.attendanceUnlockedUntil, now: context.now })
  ) {
    return {
      code: "locked",
      message: `Đã quá ${context.lockDays} ngày kể từ buổi học nên điểm danh bị khóa. Liên hệ quản trị viên để mở khóa.`,
    };
  }
  return null;
}
