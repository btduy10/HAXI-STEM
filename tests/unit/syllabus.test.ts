import { describe, expect, it } from "vitest";
import { classCodeYearPrefix, nextClassCode, nextStudentCode, nextYearCode } from "@/domain/student-code";
import { lessonLabels, lessonTitle, parseLessonLabel } from "@/domain/syllabus";
import { type RawSyllabusRow, validateSyllabusRows } from "@/domain/syllabus-import";
import { DEFAULT_PERMISSIONS, PERMISSION_MENUS, normalizePermissions, permissionConfigInput } from "@/lib/permissions";

describe("nhãn bài của Syllabus trong nội dung buổi học", () => {
  const lesson = (courseName: string, period: number, title: string) => ({ courseName, period, title });

  it("'Tên khóa · Buổi n – Tên bài', theo đúng thứ tự truyền vào", () => {
    expect(lessonLabels([lesson("Robotics 1", 1, "Làm quen với robot"), lesson("Robotics 1", 2, "Lắp ráp khung xe"), lesson("Robotics 2", 1, "Cảm biến")])).toEqual([
      "Robotics 1 · Buổi 1 – Làm quen với robot",
      "Robotics 1 · Buổi 2 – Lắp ráp khung xe",
      "Robotics 2 · Buổi 1 – Cảm biến",
    ]);
    expect(lessonLabels([])).toEqual([]);
  });

  it("đọc lại được nhãn đã tạo, kể cả tên bài có gạch nối hoặc dấu chấm giữa", () => {
    const lessons = [lesson("Robotics 1", 3, "Động cơ – bánh xe"), lesson("AI Thiếu nhi", 12, "Cảm biến · siêu âm")];
    expect(lessonLabels(lessons).map(parseLessonLabel)).toEqual(lessons);
    expect(parseLessonLabel("  Robotics 1 · Buổi 3 – Động cơ  ")).toEqual({ courseName: "Robotics 1", period: 3, title: "Động cơ" });
  });

  it("nội dung lưu trước đây không kèm tên khóa ('Buổi n – …', 'Tiết n – …') vẫn đọc được, không thuộc khóa nào", () => {
    expect(parseLessonLabel("Buổi 3 – Động cơ")).toEqual({ courseName: null, period: 3, title: "Động cơ" });
    expect(parseLessonLabel("Tiết 3 – Động cơ")).toEqual({ courseName: null, period: 3, title: "Động cơ" });
  });

  it("nội dung giáo viên tự gõ không phải nhãn bài", () => {
    for (const text of ["Ôn tập giữa khóa", "Bài 3: Động cơ", "Buổi 3 - Động cơ", "Buổi ba – Động cơ", "Buổi 3 –", ""]) expect(parseLessonLabel(text)).toBeNull();
  });

  it("tên bài trong hồ sơ học viên: 'Tên khóa · Bài n: Tên bài'; nội dung tự gõ giữ nguyên văn", () => {
    expect(lessonTitle("Robotics 1 · Buổi 3 – Lắp ráp khung xe")).toBe("Robotics 1 · Bài 3: Lắp ráp khung xe");
    expect(lessonTitle("Buổi 3 – Lắp ráp khung xe")).toBe("Bài 3: Lắp ráp khung xe");
    expect(lessonTitle("Tiết 3 – Lắp ráp khung xe")).toBe("Bài 3: Lắp ráp khung xe");
    expect(lessonTitle("  Ôn tập giữa khóa ")).toBe("Ôn tập giữa khóa");
  });
});

describe("kiểm tra dòng Excel của Syllabus", () => {
  const classes = [
    { id: "c1", code: "RB2601", name: "RB - T4" },
    { id: "c2", code: "RB2602", name: "RB - T7" },
    { id: "c3", code: "RB2603", name: "Lớp trùng tên" },
    { id: "c4", code: "RB2604", name: "Lớp trùng tên" },
  ];
  const courses = [
    { id: "k1", name: "Robotics Cơ bản" },
    { id: "k2", name: "AI Thiếu nhi" },
  ];
  const row = (rowNumber: number, cells: RawSyllabusRow["cells"]): RawSyllabusRow => ({ rowNumber, cells });
  const check = (rows: RawSyllabusRow[]) => validateSyllabusRows(rows, classes, courses);

  it("lớp ghi theo tên hoặc mã, khóa theo tên, không phân biệt hoa thường, gộp khoảng trắng; sản phẩm để trống được", () => {
    const [a, b, c] = check([
      row(2, { courseName: " robotics   cơ bản ", className: "rb -  t4", period: "1", title: "  Làm quen  với robot ", product: " Robot chào hỏi " }),
      row(3, { courseName: "AI Thiếu nhi", className: "rb2602", period: 2, title: "Nhận diện ảnh" }),
      // Hai lớp trùng tên: ghi mã thì nhận đúng lớp.
      row(4, { courseName: "AI Thiếu nhi", className: "RB2604", period: 1, title: "Bài 1" }),
    ]);
    expect(a).toMatchObject({ errors: [], data: { classId: "c1", courseId: "k1", period: 1, title: "Làm quen với robot", product: "Robot chào hỏi" } });
    expect(b).toMatchObject({ errors: [], data: { classId: "c2", courseId: "k2", period: 2, title: "Nhận diện ảnh", product: null } });
    expect(c).toMatchObject({ errors: [], data: { classId: "c4", courseId: "k2", period: 1 } });
  });

  it("cùng lớp, cùng buổi nhưng khác khóa là hai bài; trùng Lớp + Khóa + Buổi trong tệp thì dòng sau lỗi", () => {
    const results = check([
      row(2, { courseName: "Robotics Cơ bản", className: "RB - T4", period: 1, title: "Bài 1 khóa Robotics" }),
      row(3, { courseName: "AI Thiếu nhi", className: "RB - T4", period: 1, title: "Bài 1 khóa AI" }),
      row(4, { courseName: "Robotics Cơ bản", className: "RB2601", period: 1, title: "Bài 1 lặp (ghi mã lớp)" }),
    ]);
    expect(results.map((r) => r.errors)).toEqual([[], [], ["Trùng Lớp học + Khóa học + Buổi với một dòng phía trên"]]);
  });

  it("báo đủ lỗi của từng dòng: khóa không có trong menu Khóa học, lớp không có hoặc trùng tên, buổi sai, quá dài", () => {
    const results = check([
      row(2, { courseName: "Khóa lạ", className: "RB - T4", period: 2, title: "Sai khóa" }),
      row(3, { courseName: "", className: "", period: "", title: "" }),
      row(4, { courseName: "Robotics Cơ bản", className: "XX", period: 0, title: "x".repeat(201), product: "y".repeat(201) }),
      row(5, { courseName: "Robotics Cơ bản", className: "Lớp trùng tên", period: 1, title: "Không rõ lớp nào" }),
      row(6, { courseName: "Robotics Cơ bản", className: "RB - T4", period: 1.5, title: "Buổi lẻ" }),
    ]);
    expect(results.map((r) => r.errors)).toEqual([
      ['Không có khóa học "Khóa lạ" trong menu Khóa học'],
      ["Thiếu Lớp học", "Thiếu Khóa học", "Thiếu Buổi", "Thiếu Tên bài/Chủ đề"],
      ['Không có lớp "XX" trong các lớp bạn được ghi Syllabus', "Buổi phải là số nguyên từ 1 đến 999", "Tên bài/Chủ đề tối đa 200 ký tự", "Sản phẩm tối đa 200 ký tự"],
      ['Có 2 lớp tên "Lớp trùng tên"; hãy ghi mã lớp (RB2603, RB2604)'],
      ["Buổi phải là số nguyên từ 1 đến 999"],
    ]);
    expect(results.every((r) => r.data === null)).toBe(true);
  });
});

describe("mã lớp tự cấp", () => {
  it("RB + 2 số cuối của năm + số thứ tự, bắt đầu từ 01; mỗi năm đếm lại; quá 99 thì thêm chữ số", () => {
    expect(classCodeYearPrefix(2026)).toBe("RB26");
    expect(nextClassCode([], 2026)).toBe("RB2601");
    expect(nextClassCode(["RB2601", "RB2609"], 2026)).toBe("RB2610");
    expect(nextClassCode(["RB2601", "RB2657"], 2027)).toBe("RB2701");
    expect(nextClassCode(["RB2699"], 2026)).toBe("RB26100");
  });

  it("bỏ qua mã lớp cũ nhập tay và mã của loại khác; cùng cách tính với mã học viên", () => {
    expect(nextClassCode(["RB - T4", "RB-CB01", "RB26A1", "HX2605", "rb2603 "], 2026)).toBe("RB2604");
    expect(nextStudentCode(["RB2609", "HX2602"], 2026)).toBe("HX2603");
    expect(nextYearCode("AB", ["AB2601"], 2026)).toBe("AB2602");
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

  it("bảng phân quyền theo thứ tự menu: Lớp học đứng ngay trước Syllabus", () => {
    const keys = PERMISSION_MENUS.map((m) => m.key as string);
    expect(keys.indexOf("syllabus") - keys.indexOf("classes")).toBe(1);
    expect(keys.indexOf("enrollments") - keys.indexOf("syllabus")).toBe(1);
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
