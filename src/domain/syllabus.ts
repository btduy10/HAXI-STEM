// Tên bài của Syllabus khi lưu vào nội dung buổi học: "Buổi 3 – Tên bài". Giáo viên chọn nhãn này lúc điểm danh;
// hồ sơ học viên đọc lại để hiện "Bài 3: Tên bài". Nội dung lưu trước đây có dạng "Tiết 3 – Tên bài", có thể kèm
// mã môn ("ROB · Tiết 3 – Tên bài"), vẫn đọc được.

export type SyllabusLesson = { period: number; title: string };

/** Nhãn của các bài trong Syllabus của một lớp, theo đúng thứ tự truyền vào. */
export const lessonLabels = (lessons: SyllabusLesson[]): string[] => lessons.map((l) => `Buổi ${l.period} – ${l.title}`);

const LABEL = /^(?:(.+?) · )?(?:Buổi|Tiết) (\d+) – ([\s\S]+)$/;

/** Đọc nhãn bài từ nội dung buổi học; trả về null khi nội dung là chữ giáo viên tự gõ. */
export function parseLessonLabel(content: string): { subjectCode: string | null; period: number; title: string } | null {
  const match = LABEL.exec(content.trim());
  if (!match) return null;
  return { subjectCode: match[1] ?? null, period: Number(match[2]), title: match[3]!.trim() };
}

/** Tên bài hiện trong hồ sơ học viên: "Bài 3: Tên bài" (kèm mã môn của nội dung cũ nếu có); nội dung tự gõ giữ nguyên văn. */
export function lessonTitle(content: string): string {
  const lesson = parseLessonLabel(content);
  if (!lesson) return content.trim();
  return `${lesson.subjectCode ? `${lesson.subjectCode} · ` : ""}Bài ${lesson.period}: ${lesson.title}`;
}
