import { describe, expect, it } from "vitest";
import { lessonLabels, lessonTitle, parseLessonLabel } from "@/domain/syllabus";
import { type RawSyllabusRow, validateSyllabusRows } from "@/domain/syllabus-import";
import { DEFAULT_PERMISSIONS, PERMISSION_MENUS, normalizePermissions, permissionConfigInput } from "@/lib/permissions";

describe("nhãn bài của Syllabus trong nội dung buổi học", () => {
  it("'Buổi n – Tên bài', theo đúng thứ tự truyền vào", () => {
    expect(lessonLabels([{ period: 1, title: "Làm quen với robot" }, { period: 2, title: "Lắp ráp khung xe" }])).toEqual([
      "Buổi 1 – Làm quen với robot",
      "Buổi 2 – Lắp ráp khung xe",
    ]);
    expect(lessonLabels([])).toEqual([]);
  });

  it("đọc lại được nhãn đã tạo, kể cả tên bài có gạch nối hoặc dấu chấm giữa", () => {
    const lessons = [{ period: 3, title: "Động cơ – bánh xe" }, { period: 12, title: "Cảm biến · siêu âm" }];
    expect(lessonLabels(lessons).map(parseLessonLabel)).toEqual(lessons.map((l) => ({ subjectCode: null, ...l })));
    expect(parseLessonLabel("  Buổi 3 – Động cơ  ")).toEqual({ subjectCode: null, period: 3, title: "Động cơ" });
  });

  it("nội dung lưu trước đây dạng 'Tiết n – …', có thể kèm mã môn, vẫn đọc được", () => {
    expect(parseLessonLabel("Tiết 3 – Động cơ")).toEqual({ subjectCode: null, period: 3, title: "Động cơ" });
    expect(parseLessonLabel("ROB · Tiết 1 – Làm quen với robot")).toEqual({ subjectCode: "ROB", period: 1, title: "Làm quen với robot" });
  });

  it("nội dung giáo viên tự gõ không phải nhãn bài", () => {
    for (const text of ["Ôn tập giữa khóa", "Bài 3: Động cơ", "Buổi 3 - Động cơ", "Buổi ba – Động cơ", "Buổi 3 –", ""]) expect(parseLessonLabel(text)).toBeNull();
  });

  it("tên bài trong hồ sơ học viên: 'Bài n: Tên bài'; nội dung tự gõ giữ nguyên văn", () => {
    expect(lessonTitle("Buổi 3 – Lắp ráp khung xe")).toBe("Bài 3: Lắp ráp khung xe");
    expect(lessonTitle("Tiết 3 – Lắp ráp khung xe")).toBe("Bài 3: Lắp ráp khung xe");
    expect(lessonTitle("ROB · Tiết 1 – Làm quen với robot")).toBe("ROB · Bài 1: Làm quen với robot");
    expect(lessonTitle("  Ôn tập giữa khóa ")).toBe("Ôn tập giữa khóa");
  });
});

describe("kiểm tra dòng Excel của Syllabus", () => {
  const classes = new Map([
    ["rb-01", { id: "c1", courseName: "Robotics Cơ bản" }],
    ["ai-01", { id: "c2", courseName: "AI Thiếu nhi" }],
  ]);
  const row = (rowNumber: number, cells: RawSyllabusRow["cells"]): RawSyllabusRow => ({ rowNumber, cells });

  it("dòng hợp lệ: mã lớp và tên khóa không phân biệt hoa thường, gộp khoảng trắng; sản phẩm để trống được", () => {
    const [a, b] = validateSyllabusRows(
      [
        row(2, { courseName: " robotics   cơ bản ", classCode: "RB-01", period: "1", title: "  Làm quen  với robot ", product: " Robot chào hỏi " }),
        row(3, { courseName: "AI Thiếu nhi", classCode: "ai-01", period: 2, title: "Nhận diện ảnh" }),
      ],
      classes,
    );
    expect(a).toMatchObject({ errors: [], data: { classId: "c1", period: 1, title: "Làm quen với robot", product: "Robot chào hỏi" } });
    expect(b).toMatchObject({ errors: [], data: { classId: "c2", period: 2, title: "Nhận diện ảnh", product: null } });
  });

  it("báo đủ lỗi của từng dòng; trùng Lớp học + Buổi trong tệp thì dòng sau lỗi", () => {
    const results = validateSyllabusRows(
      [
        row(2, { courseName: "Robotics Cơ bản", classCode: "RB-01", period: 1, title: "Bài 1" }),
        row(3, { courseName: "Robotics Cơ bản", classCode: "rb-01", period: 1, title: "Bài 1 lặp" }),
        row(4, { courseName: "AI Thiếu nhi", classCode: "RB-01", period: 2, title: "Sai khóa" }),
        row(5, { courseName: "", classCode: "", period: "", title: "" }),
        row(6, { courseName: "Robotics Cơ bản", classCode: "XX", period: 0, title: "x".repeat(201), product: "y".repeat(201) }),
        row(7, { courseName: "Robotics Cơ bản", classCode: "RB-01", period: 1.5, title: "Buổi lẻ" }),
      ],
      classes,
    );
    expect(results.map((r) => r.errors)).toEqual([
      [],
      ["Trùng Lớp học + Buổi với một dòng phía trên"],
      ['Lớp RB-01 thuộc khóa "Robotics Cơ bản", không phải "AI Thiếu nhi"'],
      ["Thiếu Lớp học", "Thiếu Khóa học", "Thiếu Buổi", "Thiếu Tên bài/Chủ đề"],
      ['Không có lớp mã "XX" trong các lớp bạn được ghi Syllabus', "Buổi phải là số nguyên từ 1 đến 999", "Tên bài/Chủ đề tối đa 200 ký tự", "Sản phẩm tối đa 200 ký tự"],
      ["Buổi phải là số nguyên từ 1 đến 999"],
    ]);
    expect(results.filter((r) => r.data)).toHaveLength(1);
  });
});

describe("ô tick Xóa trong bảng phân quyền", () => {
  const withDelete = PERMISSION_MENUS.filter((m) => (m.actions as readonly string[]).includes("delete")).map((m) => m.key);

  it("chỉ menu Syllabus có ô Xóa; mặc định Giáo viên được Xem, Thêm, Sửa, Xóa Syllabus, Giáo viên trực thì không", () => {
    expect(withDelete).toEqual(["syllabus"]);
    expect(DEFAULT_PERMISSIONS.teacher!.menus.syllabus).toEqual({ view: true, add: true, edit: true, delete: true });
    expect(DEFAULT_PERMISSIONS.duty_teacher!.menus.syllabus).toEqual({ view: false, add: false, edit: false, delete: false });
    expect(DEFAULT_PERMISSIONS.teacher!.menus.attendance).toEqual({ view: true, add: true, edit: true });
    expect(normalizePermissions(DEFAULT_PERMISSIONS)).toEqual(DEFAULT_PERMISSIONS);
  });

  it("cấu hình lưu trước khi có ô Xóa: các ô đã tick giữ nguyên, Xóa coi như chưa tick", () => {
    const saved = structuredClone(DEFAULT_PERMISSIONS) as Record<string, { menus: Record<string, unknown> }>;
    saved.teacher!.menus.syllabus = { view: true, add: false, edit: true };
    saved.teacher!.menus.classes = { view: true, add: true, edit: false };
    saved.duty_teacher!.menus.syllabus = { view: true, add: true, edit: true };
    const normalized = normalizePermissions(saved);
    expect(normalized.teacher!.menus.syllabus).toEqual({ view: true, add: false, edit: true, delete: false });
    expect(normalized.teacher!.menus.classes).toEqual({ view: true, add: true, edit: false });
    expect(normalized.duty_teacher!.menus.syllabus).toEqual({ view: true, add: true, edit: true, delete: false });
  });

  it("không có Xem thì không có Xóa; menu không hỗ trợ thì bỏ ô Xóa gửi kèm", () => {
    const sent = structuredClone(DEFAULT_PERMISSIONS) as Record<string, { menus: Record<string, unknown> }>;
    sent.teacher!.menus.syllabus = { view: false, add: false, edit: false, delete: true };
    sent.teacher!.menus.classes = { view: true, add: false, edit: false, delete: true };
    expect(permissionConfigInput.safeParse(sent).success).toBe(true);
    const normalized = normalizePermissions(sent);
    expect(normalized.teacher!.menus.syllabus).toEqual({ view: false, add: false, edit: false, delete: false });
    expect(normalized.teacher!.menus.classes).toEqual({ view: true, add: false, edit: false });
  });
});
