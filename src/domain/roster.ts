import { SLOT_NAMES, SLOT_NAME_LABELS } from "@/lib/validation/entities";

// Bảng tổng quan Ghi danh theo buổi học trong tuần (buổi = ca + thứ, lấy từ lịch mẫu của lớp).

/** Số hàng tối thiểu của mỗi lớp trên bảng tổng quan; lớp đông hơn thì hiện đủ học viên. */
export const ROSTER_ROWS = 8;

/** Tên thứ dạng "Thứ 2" … "Chủ nhật" theo thứ ISO (1 = Thứ 2). */
export const DAY_LABELS: Record<number, string> = { 1: "Thứ 2", 2: "Thứ 3", 3: "Thứ 4", 4: "Thứ 5", 5: "Thứ 6", 6: "Thứ 7", 7: "Chủ nhật" };

/** Tên buổi: "Ca tối" + thứ 1 → "Tối Thứ 2"; thứ 7 của tuần là Chủ nhật. */
export function rosterSessionLabel(slotName: string, weekday: number): string {
  const shift = (SLOT_NAME_LABELS as Record<string, string>)[slotName] ?? slotName;
  return `${shift} ${DAY_LABELS[weekday] ?? ""}`.trim();
}

/** Giờ trên tiêu đề buổi: "19:00:00" → "19h00". */
export const rosterTime = (time: string) => time.slice(0, 5).replace(":", "h");

const shiftIndex = (slotName: string) => (SLOT_NAMES as readonly string[]).indexOf(slotName);

/** Thứ tự hiển thị các buổi: theo từng ngày từ Thứ 2 đến Chủ nhật, trong ngày Sáng → Chiều → Tối. */
export function rosterSessionOrder(slotName: string, weekday: number): number {
  const shift = shiftIndex(slotName);
  return weekday * 10 + (shift < 0 ? 9 : shift);
}

// Màu theo giáo viên: mỗi giáo viên một tông; các buổi của cùng một người cùng tông, đậm nhạt khác nhau.
// Ba tông đầu là ba tông thương hiệu của Thời khóa biểu (vàng, xanh dương, xanh ngọc), các tông sau xen giữa.
const TEACHER_HUES = [75, 255, 185, 320, 135, 20, 290, 105, 220, 350, 48, 160] as const;
/** Số tông màu; giáo viên thứ `ROSTER_TONES` trở đi quay vòng lại tông đầu. */
export const ROSTER_TONES = TEACHER_HUES.length;
/** Độ sáng (OKLCH) của buổi nhạt nhất và đậm nhất của một giáo viên; chữ navy trên cả khoảng này đạt tương phản AA. */
export const ROSTER_LIGHTEST = 0.93;
export const ROSTER_DARKEST = 0.78;
const BASE_CHROMA = 0.03;
const CHROMA_GAIN = 0.45;
const round = (value: number) => Math.round(value * 1000) / 1000;

export type RosterShade = { header: string; accent: string };

/** Màu của buổi chưa có giáo viên: xám trung tính. */
export const ROSTER_NO_TEACHER_SHADE: RosterShade = { header: "oklch(0.93 0.006 255)", accent: "oklch(0.71 0.012 255)" };

/**
 * Màu của một buổi trên bảng tổng quan Ghi danh: `header` là nền tiêu đề khung, `accent` là viền trên cùng tông, đậm hơn.
 * `teacherIndex`: thứ tự của giáo viên (từ 0) quyết định tông; `position`/`count`: mức đậm thứ mấy (từ 0) trong số buổi
 * của giáo viên đó trong tuần (mức 0 nhạt nhất, mức càng cao càng đậm và rực hơn; chỉ một buổi thì lấy mức giữa).
 */
export function rosterTeacherShade(teacherIndex: number, position: number, count: number): RosterShade {
  const hue = TEACHER_HUES[Math.max(teacherIndex, 0) % ROSTER_TONES]!;
  const span = ROSTER_LIGHTEST - ROSTER_DARKEST;
  const step = count <= 1 ? 0.5 : Math.min(Math.max(position, 0), count - 1) / (count - 1);
  const lightness = round(ROSTER_LIGHTEST - span * step);
  const chroma = round(BASE_CHROMA + (ROSTER_LIGHTEST - lightness) * CHROMA_GAIN);
  return { header: `oklch(${lightness} ${chroma} ${hue})`, accent: `oklch(${round(lightness - 0.22)} 0.09 ${hue})` };
}
