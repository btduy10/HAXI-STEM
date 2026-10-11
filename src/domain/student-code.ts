// Mã tự cấp theo năm: tiền tố + 2 số cuối của năm + số thứ tự trong năm.
// Học viên: HX2601, HX2602, … Lớp học: RB2601, RB2602, …

/** Phần đầu mã của một năm: ("HX", 2026) → "HX26". */
export const yearCodePrefix = (prefix: string, year: number) => `${prefix}${String(year % 100).padStart(2, "0")}`;

/**
 * Mã kế tiếp của năm `year`: số thứ tự lớn nhất đang có của năm đó cộng 1, tối thiểu 2 chữ số
 * (quá 99 thì thành HX26100). Mã không đúng mẫu (vd. HV001 nhập tay) được bỏ qua.
 */
export function nextYearCode(prefix: string, existing: Iterable<string>, year: number): string {
  const head = yearCodePrefix(prefix, year);
  let max = 0;
  for (const code of existing) {
    const upper = code.trim().toUpperCase();
    if (!upper.startsWith(head)) continue;
    const rest = upper.slice(head.length);
    if (/^\d{2,}$/.test(rest)) max = Math.max(max, Number(rest));
  }
  return `${head}${String(max + 1).padStart(2, "0")}`;
}

export const STUDENT_CODE_PREFIX = "HX";
export const studentCodeYearPrefix = (year: number) => yearCodePrefix(STUDENT_CODE_PREFIX, year);
export const nextStudentCode = (existing: Iterable<string>, year: number) => nextYearCode(STUDENT_CODE_PREFIX, existing, year);

export const CLASS_CODE_PREFIX = "RB";
export const classCodeYearPrefix = (year: number) => yearCodePrefix(CLASS_CODE_PREFIX, year);
export const nextClassCode = (existing: Iterable<string>, year: number) => nextYearCode(CLASS_CODE_PREFIX, existing, year);
