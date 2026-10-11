// Tên bài của Syllabus khi lưu vào nội dung buổi học: "Tiết 3 – Tên bài", kèm mã môn ("ROB · Tiết 3 – Tên bài")
// khi lớp có nhiều môn. Giáo viên chọn nhãn này lúc điểm danh; hồ sơ học viên đọc lại để hiện "Bài 3: Tên bài".

export type SyllabusLesson = { subjectCode: string; period: number; title: string };

/** Nhãn của các bài trong Syllabus của một lớp, theo đúng thứ tự truyền vào. */
export function lessonLabels(lessons: SyllabusLesson[]): string[] {
  const manySubjects = new Set(lessons.map((l) => l.subjectCode)).size > 1;
  return lessons.map((l) => `${manySubjects ? `${l.subjectCode} · ` : ""}Tiết ${l.period} – ${l.title}`);
}

const LABEL = /^(?:(.+?) · )?Tiết (\d+) – ([\s\S]+)$/;

/** Đọc nhãn bài từ nội dung buổi học; trả về null khi nội dung là chữ giáo viên tự gõ. */
export function parseLessonLabel(content: string): { subjectCode: string | null; period: number; title: string } | null {
  const match = LABEL.exec(content.trim());
  if (!match) return null;
  return { subjectCode: match[1] ?? null, period: Number(match[2]), title: match[3]!.trim() };
}

/** Tên bài hiện trong hồ sơ học viên: "Bài 3: Tên bài" (kèm mã môn nếu có); nội dung tự gõ giữ nguyên văn. */
export function lessonTitle(content: string): string {
  const lesson = parseLessonLabel(content);
  if (!lesson) return content.trim();
  return `${lesson.subjectCode ? `${lesson.subjectCode} · ` : ""}Bài ${lesson.period}: ${lesson.title}`;
}
