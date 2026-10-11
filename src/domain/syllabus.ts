// Tên bài của Syllabus khi lưu vào nội dung buổi học: "Tên khóa · Buổi 3 – Tên bài". Giáo viên chọn nhãn này lúc điểm danh;
// hồ sơ học viên đọc lại để hiện "Tên khóa · Bài 3: Tên bài" và đếm số buổi đã học của từng khóa.
// Nội dung lưu trước đây không kèm tên khóa ("Buổi 3 – Tên bài", "Tiết 3 – Tên bài") vẫn đọc được, nhưng không thuộc khóa nào.

export type SyllabusLesson = { courseName: string; period: number; title: string };

/** Nhãn của các bài trong Syllabus của một lớp, theo đúng thứ tự truyền vào. */
export const lessonLabels = (lessons: SyllabusLesson[]): string[] => lessons.map((l) => `${l.courseName} · Buổi ${l.period} – ${l.title}`);

const LABEL = /^(?:(.+?) · )?(?:Buổi|Tiết) (\d+) – ([\s\S]+)$/;

/** Đọc nhãn bài từ nội dung buổi học; trả về null khi nội dung là chữ giáo viên tự gõ. `courseName` null = nhãn cũ không kèm tên khóa. */
export function parseLessonLabel(content: string): { courseName: string | null; period: number; title: string } | null {
  const match = LABEL.exec(content.trim());
  if (!match) return null;
  return { courseName: match[1]?.trim() || null, period: Number(match[2]), title: match[3]!.trim() };
}

/** Tên bài hiện trong hồ sơ học viên: "Tên khóa · Bài 3: Tên bài"; nội dung tự gõ giữ nguyên văn. */
export function lessonTitle(content: string): string {
  const lesson = parseLessonLabel(content);
  if (!lesson) return content.trim();
  return `${lesson.courseName ? `${lesson.courseName} · ` : ""}Bài ${lesson.period}: ${lesson.title}`;
}
