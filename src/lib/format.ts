export const TIME_ZONE = "Asia/Ho_Chi_Minh";

/** "2026-10-05" → "05/10/2026" */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

/** Số tiền đồng, vd. 300000 → "300.000 đ". */
export function formatMoney(value: number): string {
  return `${value.toLocaleString("vi-VN")} đ`;
}

export function formatDateTime(value: Date | null | undefined): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("vi-VN", { timeZone: TIME_ZONE, dateStyle: "short", timeStyle: "short" }).format(value);
}

/** "08:00:00" → "08:00" */
export const formatTime = (time: string | null | undefined) => (time ? time.slice(0, 5) : "");

/** Ngày hiện tại theo giờ Việt Nam, dạng "yyyy-mm-dd". */
export function todayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
}

/** Giờ hiện tại theo giờ Việt Nam, dạng "HH:MM" (24 giờ). */
export function timeNow(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
}

export const LABELS = {
  teacherStatus: { active: "Đang dạy", inactive: "Ngừng dạy" },
  studentStatus: { active: "Đang học", paused: "Tạm nghỉ", left: "Đã nghỉ" },
  gender: { male: "Nam", female: "Nữ", other: "Khác" },
  classStatus: { open: "Đang mở", closed: "Đã đóng" },
  classTeacherRole: { main: "GV chính", assistant: "Trợ giảng" },
  enrollmentStatus: { active: "Đang học", left: "Đã rời lớp" },
  attendanceStatus: { present: "Có mặt", late: "Đi trễ", left_early: "Về sớm", excused: "Vắng có phép", absent: "Vắng" },
  handoverStatus: { pending: "Đã duyệt, chờ trao", given: "Đã trao" },
  role: { admin: "Quản trị", teacher: "Giáo viên", duty_teacher: "Giáo viên trực" },
} as const;

export const toOptions = (labels: Record<string, string>) =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));
