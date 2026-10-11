import { isEnrolledOn } from "./schedule";
import { clampTotal } from "./stars";

// Quy tắc thuần của tổng kết cuối khóa: chuyên cần, xếp hạng, chọn mốc quà.

export type AttendanceStatus = "present" | "excused" | "absent" | "late" | "left_early";
export const ATTENDED: ReadonlySet<AttendanceStatus> = new Set(["present", "late", "left_early"]);

export type TaughtSession = {
  id: string;
  date: string;
  kind: "regular" | "makeup";
  status: "planned" | "done" | "cancelled";
  /** Chỉ dùng với buổi bù: các học viên được chọn. */
  studentIds?: ReadonlySet<string>;
};

export type AttendanceCounts = Record<AttendanceStatus, number> & {
  /** Số buổi thực tế đã dạy mà học viên thuộc danh sách. */
  taught: number;
  /** Tỷ lệ chuyên cần, 0–100, làm tròn 2 chữ số. */
  rate: number;
};

/**
 * Chuyên cần của một học viên trong một lớp.
 * Mẫu số = buổi ĐÃ DẠY (status = done) mà học viên có trong danh sách tại ngày đó;
 * buổi hủy và buổi chưa diễn ra không tính. Tử số = có mặt + đi trễ + về sớm.
 */
export function attendanceOf(
  studentId: string,
  enrollments: { joinedAt: string; leftAt: string | null }[],
  sessions: TaughtSession[],
  statusBySession: ReadonlyMap<string, AttendanceStatus>,
): AttendanceCounts {
  const counts: AttendanceCounts = { present: 0, excused: 0, absent: 0, late: 0, left_early: 0, taught: 0, rate: 0 };
  for (const session of sessions) {
    if (session.status !== "done") continue;
    const inRoster =
      session.kind === "makeup" ? (session.studentIds?.has(studentId) ?? false) : enrollments.some((e) => isEnrolledOn(e, session.date));
    if (!inRoster) continue;
    counts.taught++;
    // Buổi đã dạy nhưng thiếu dòng điểm danh của em này (vd. ghi danh bổ sung sau) tính là vắng.
    counts[statusBySession.get(session.id) ?? "absent"]++;
  }
  const attended = counts.present + counts.late + counts.left_early;
  counts.rate = counts.taught === 0 ? 0 : Math.round((attended / counts.taught) * 10000) / 100;
  return counts;
}

/** Tổng sao theo lớp: chỉ các lần ghi trong buổi của lớp đó, không âm. */
export const classStarTotal = (rawSum: number) => clampTotal(rawSum);

/** Xếp hạng theo tổng sao giảm dần, đồng hạng kiểu 1-2-2-4. */
export function rankByStars<T extends { totalStars: number }>(rows: T[]): (T & { rank: number })[] {
  const sorted = [...rows].sort((a, b) => b.totalStars - a.totalStars);
  let rank = 0;
  return sorted.map((row, index) => {
    if (index === 0 || row.totalStars < sorted[index - 1]!.totalStars) rank = index + 1;
    return { ...row, rank };
  });
}

export type RewardTier = { id: string; minStars: number; giftId: string; classId: string | null; courseId: string | null };

/**
 * Mốc quà áp dụng cho học viên: mốc cao nhất có min_stars ≤ tổng sao khóa.
 * Mốc quà đặt theo lớp: chỉ dùng mốc của chính lớp đó (mốc không gắn lớp là dữ liệu cũ theo khóa học, đã được chép sang từng lớp).
 */
export function pickTier(totalStars: number, tiers: RewardTier[], classId: string): RewardTier | null {
  const ofClass = tiers.filter((t) => t.classId === classId);
  const pool = ofClass.length > 0 ? ofClass : tiers.filter((t) => t.classId === null);
  return pool.filter((t) => t.minStars <= totalStars).sort((a, b) => b.minStars - a.minStars)[0] ?? null;
}
