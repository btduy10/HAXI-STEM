import { describe, expect, it } from "vitest";
import { lessonLabels, lessonTitle, parseLessonLabel } from "@/domain/syllabus";

describe("nhãn bài của Syllabus trong nội dung buổi học", () => {
  const rob = (period: number, title: string) => ({ subjectCode: "ROB", period, title });

  it("lớp một môn: 'Tiết n – Tên bài'; lớp nhiều môn kèm mã môn", () => {
    expect(lessonLabels([rob(1, "Làm quen với robot"), rob(2, "Lắp ráp khung xe")])).toEqual(["Tiết 1 – Làm quen với robot", "Tiết 2 – Lắp ráp khung xe"]);
    expect(lessonLabels([rob(1, "Làm quen"), { subjectCode: "AI", period: 1, title: "Nhận diện ảnh" }])).toEqual([
      "ROB · Tiết 1 – Làm quen",
      "AI · Tiết 1 – Nhận diện ảnh",
    ]);
    expect(lessonLabels([])).toEqual([]);
  });

  it("đọc lại được nhãn đã tạo, kể cả tên bài có gạch nối hoặc dấu chấm giữa", () => {
    for (const lessons of [[rob(3, "Động cơ – bánh xe")], [rob(12, "Cảm biến · siêu âm"), { subjectCode: "AI-2", period: 4, title: "Mô hình" }]]) {
      const many = lessons.length > 1;
      expect(lessonLabels(lessons).map(parseLessonLabel)).toEqual(lessons.map((l) => ({ subjectCode: many ? l.subjectCode : null, period: l.period, title: l.title })));
    }
    expect(parseLessonLabel("  Tiết 3 – Động cơ  ")).toEqual({ subjectCode: null, period: 3, title: "Động cơ" });
  });

  it("nội dung giáo viên tự gõ không phải nhãn bài", () => {
    for (const text of ["Ôn tập giữa khóa", "Bài 3: Động cơ", "Tiết 3 - Động cơ", "Tiết ba – Động cơ", "Tiết 3 –", ""]) expect(parseLessonLabel(text)).toBeNull();
  });

  it("tên bài trong hồ sơ học viên: 'Bài n: Tên bài'; nội dung tự gõ giữ nguyên văn", () => {
    expect(lessonTitle("Tiết 3 – Lắp ráp khung xe")).toBe("Bài 3: Lắp ráp khung xe");
    expect(lessonTitle("ROB · Tiết 1 – Làm quen với robot")).toBe("ROB · Bài 1: Làm quen với robot");
    expect(lessonTitle("  Ôn tập giữa khóa ")).toBe("Ôn tập giữa khóa");
  });
});
