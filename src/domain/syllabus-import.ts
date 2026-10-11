// Nhập Syllabus từ Excel: kiểm tra từng dòng, không chạm CSDL (danh sách lớp hợp lệ do nơi gọi truyền vào).

export const SYLLABUS_COLUMNS = [
  { key: "courseName", header: "Khóa học" },
  { key: "classCode", header: "Lớp học" },
  { key: "period", header: "Buổi" },
  { key: "title", header: "Tên bài/Chủ đề" },
  { key: "product", header: "Sản phẩm" },
] as const;

export type SyllabusKey = (typeof SYLLABUS_COLUMNS)[number]["key"];
export type RawSyllabusRow = { rowNumber: number; cells: Partial<Record<SyllabusKey, unknown>> };
export type SyllabusRowData = { classId: string; period: number; title: string; product: string | null };
export type SyllabusRowResult = {
  rowNumber: number;
  courseName: string;
  classCode: string;
  period: string;
  title: string;
  product: string;
  errors: string[];
  data: SyllabusRowData | null;
};
/** Lớp mà người nhập được phép ghi Syllabus: mã lớp → id lớp và tên khóa học của lớp. */
export type SyllabusClass = { id: string; courseName: string };

const text = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const SYLLABUS_TEXT_MAX = 200;

/**
 * Kiểm tra từng dòng. `classByCode`: mã lớp (đã chuẩn hóa chữ thường) → lớp trong phạm vi của người nhập.
 * Cột Khóa học phải đúng tên khóa của lớp. Hai dòng cùng Lớp + Buổi trong một tệp: dòng sau bị báo lỗi.
 */
export function validateSyllabusRows(rows: RawSyllabusRow[], classByCode: ReadonlyMap<string, SyllabusClass>): SyllabusRowResult[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const courseName = text(row.cells.courseName);
    const classCode = text(row.cells.classCode);
    const periodText = text(row.cells.period);
    const title = text(row.cells.title);
    const product = text(row.cells.product);
    const errors: string[] = [];

    const cls = classByCode.get(classCode.toLowerCase());
    if (!classCode) errors.push("Thiếu Lớp học");
    else if (!cls) errors.push(`Không có lớp mã "${classCode}" trong các lớp bạn được ghi Syllabus`);
    if (!courseName) errors.push("Thiếu Khóa học");
    else if (cls && !same(cls.courseName, courseName)) errors.push(`Lớp ${classCode} thuộc khóa "${cls.courseName}", không phải "${courseName}"`);
    const period = Number(periodText);
    if (!periodText) errors.push("Thiếu Buổi");
    else if (!Number.isInteger(period) || period < 1 || period > 999) errors.push("Buổi phải là số nguyên từ 1 đến 999");
    if (!title) errors.push("Thiếu Tên bài/Chủ đề");
    else if (title.length > SYLLABUS_TEXT_MAX) errors.push(`Tên bài/Chủ đề tối đa ${SYLLABUS_TEXT_MAX} ký tự`);
    if (product.length > SYLLABUS_TEXT_MAX) errors.push(`Sản phẩm tối đa ${SYLLABUS_TEXT_MAX} ký tự`);

    if (errors.length === 0) {
      const key = `${cls!.id}|${period}`;
      if (seen.has(key)) errors.push("Trùng Lớp học + Buổi với một dòng phía trên");
      seen.add(key);
    }
    const data = errors.length === 0 ? { classId: cls!.id, period, title, product: product || null } : null;
    return { rowNumber: row.rowNumber, courseName, classCode, period: periodText, title, product, errors, data };
  });
}
