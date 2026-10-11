// Nhập Syllabus từ Excel: kiểm tra từng dòng, không chạm CSDL (danh sách lớp và khóa học hợp lệ do nơi gọi truyền vào).

export const SYLLABUS_COLUMNS = [
  { key: "courseName", header: "Khóa học" },
  { key: "className", header: "Lớp học" },
  { key: "period", header: "Buổi" },
  { key: "title", header: "Tên bài/Chủ đề" },
  { key: "product", header: "Sản phẩm" },
] as const;

export type SyllabusKey = (typeof SYLLABUS_COLUMNS)[number]["key"];
export type RawSyllabusRow = { rowNumber: number; cells: Partial<Record<SyllabusKey, unknown>> };
export type SyllabusRowData = { classId: string; courseId: string; period: number; title: string; product: string | null };
export type SyllabusRowResult = {
  rowNumber: number;
  courseName: string;
  className: string;
  period: string;
  title: string;
  product: string;
  errors: string[];
  data: SyllabusRowData | null;
};
/** Lớp mà người nhập được phép ghi Syllabus (trong phạm vi của mình). */
export type SyllabusClass = { id: string; code: string; name: string };
/** Khóa học có trong menu Khóa học. */
export type SyllabusCourse = { id: string; name: string };

const text = (value: unknown) => String(value ?? "").trim().replace(/\s+/g, " ");
const key = (value: string) => text(value).toLowerCase();

export const SYLLABUS_TEXT_MAX = 200;

/**
 * Kiểm tra từng dòng. Cột Lớp học ghi tên lớp hoặc mã lớp (dò theo tên trước, không thấy thì dò theo mã; hai lớp trùng tên
 * thì phải ghi mã). Cột Khóa học ghi tên một khóa có trong menu Khóa học. Hai dòng cùng Lớp + Khóa + Buổi trong một tệp:
 * dòng sau bị báo lỗi.
 */
export function validateSyllabusRows(rows: RawSyllabusRow[], classes: readonly SyllabusClass[], courses: readonly SyllabusCourse[]): SyllabusRowResult[] {
  const byName = new Map<string, SyllabusClass[]>();
  for (const cls of classes) byName.set(key(cls.name), [...(byName.get(key(cls.name)) ?? []), cls]);
  const byCode = new Map(classes.map((cls) => [key(cls.code), cls]));
  const courseByName = new Map(courses.map((course) => [key(course.name), course]));
  const seen = new Set<string>();

  return rows.map((row) => {
    const courseName = text(row.cells.courseName);
    const className = text(row.cells.className);
    const periodText = text(row.cells.period);
    const title = text(row.cells.title);
    const product = text(row.cells.product);
    const errors: string[] = [];

    const named = byName.get(key(className)) ?? [];
    const cls = named.length === 1 ? named[0] : named.length === 0 ? byCode.get(key(className)) : undefined;
    if (!className) errors.push("Thiếu Lớp học");
    else if (named.length > 1) errors.push(`Có ${named.length} lớp tên "${className}"; hãy ghi mã lớp (${named.map((c) => c.code).join(", ")})`);
    else if (!cls) errors.push(`Không có lớp "${className}" trong các lớp bạn được ghi Syllabus`);
    const course = courseByName.get(key(courseName));
    if (!courseName) errors.push("Thiếu Khóa học");
    else if (!course) errors.push(`Không có khóa học "${courseName}" trong menu Khóa học`);
    const period = Number(periodText);
    if (!periodText) errors.push("Thiếu Buổi");
    else if (!Number.isInteger(period) || period < 1 || period > 999) errors.push("Buổi phải là số nguyên từ 1 đến 999");
    if (!title) errors.push("Thiếu Tên bài/Chủ đề");
    else if (title.length > SYLLABUS_TEXT_MAX) errors.push(`Tên bài/Chủ đề tối đa ${SYLLABUS_TEXT_MAX} ký tự`);
    if (product.length > SYLLABUS_TEXT_MAX) errors.push(`Sản phẩm tối đa ${SYLLABUS_TEXT_MAX} ký tự`);

    if (errors.length === 0) {
      const lessonKey = `${cls!.id}|${course!.id}|${period}`;
      if (seen.has(lessonKey)) errors.push("Trùng Lớp học + Khóa học + Buổi với một dòng phía trên");
      seen.add(lessonKey);
    }
    const data = errors.length === 0 ? { classId: cls!.id, courseId: course!.id, period, title, product: product || null } : null;
    return { rowNumber: row.rowNumber, courseName, className, period: periodText, title, product, errors, data };
  });
}
