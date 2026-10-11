import { describe, expect, it } from "vitest";
import { accountInput, classInput, password, studentInput, teacherInput, timeSlotInput } from "@/lib/validation/entities";
import { consumeToken, resetRateLimits } from "@/server/rate-limit";

describe("xác thực dữ liệu vào", () => {
  it("học viên: chuẩn hóa mã, bỏ trống thành null, chặn giá trị sai", () => {
    const ok = studentInput.parse({ code: " hv01 ", fullName: "  An  ", birthDate: "", gender: "", schoolGrade: "", phone: "", note: "" });
    expect(ok).toMatchObject({ code: "HV01", fullName: "An", birthDate: null, gender: null, schoolGrade: null, phone: null, status: "active" });
    expect(studentInput.safeParse({ code: "HV 01", fullName: "An" }).success).toBe(false);
    expect(studentInput.safeParse({ code: "HV01", fullName: "An", birthDate: "2015-02-30" }).success).toBe(false);
    expect(studentInput.safeParse({ code: "HV01", fullName: "An", schoolGrade: "13" }).success).toBe(false);
    expect(studentInput.safeParse({ code: "HV01", fullName: "An", status: "admin" }).success).toBe(false);
  });

  it("ca học và lớp: thời gian kết thúc phải sau bắt đầu", () => {
    expect(timeSlotInput.safeParse({ name: "Ca sáng", frame: "1", defaultStart: "09:00", defaultEnd: "08:00" }).success).toBe(false);
    // Ca chỉ chọn trong Sáng / Chiều / Tối, không nhập tên tự do.
    expect(timeSlotInput.safeParse({ name: "Ca khác", frame: "1", defaultStart: "08:00", defaultEnd: "09:00" }).success).toBe(false);
    expect(timeSlotInput.parse({ name: "Ca sáng", frame: "2", defaultStart: "08:00:00", defaultEnd: "09:30" })).toMatchObject({ frame: 2, defaultStart: "08:00", defaultEnd: "09:30" });
    const base = { name: "Lớp", maxSize: 5 };
    expect(classInput.safeParse({ ...base, startDate: "2026-03-01", endDate: "2026-01-01" }).success).toBe(false);
    expect(classInput.safeParse({ ...base, startDate: "2026-01-01", endDate: "2026-03-01" }).success).toBe(true);
    // Mã lớp do máy chủ tự cấp và lớp không gắn khóa học: mã, khóa gửi kèm từ form bị bỏ qua; tên lớp bắt buộc.
    const dates = { startDate: "2026-01-01", endDate: "2026-03-01" };
    const parsed = classInput.parse({ ...base, ...dates, code: "TU-DAT", courseId: "3f2b1c9e-8a47-4c1d-9b2e-5d6f7a8b9c0d" });
    expect(parsed).not.toHaveProperty("code");
    expect(parsed).not.toHaveProperty("courseId");
    expect(classInput.safeParse({ ...base, ...dates, name: "   " }).success).toBe(false);
    // "Chỉ trên Thời khóa biểu": form gửi "true"/"false"; không gửi thì là lớp thường.
    expect(classInput.parse({ ...base, ...dates }).timetableOnly).toBe(false);
    expect(classInput.parse({ ...base, ...dates, timetableOnly: "true" }).timetableOnly).toBe(true);
    expect(classInput.parse({ ...base, ...dates, timetableOnly: "false" }).timetableOnly).toBe(false);
    expect(classInput.safeParse({ ...base, ...dates, timetableOnly: "co" }).success).toBe(false);
    expect(teacherInput.parse({ code: " GV - Lan ", fullName: "Lan", phone: "", email: "" }).code).toBe("GV - Lan");
    // Tên viết tắt: không bắt buộc, bỏ trống thành null, tối đa 20 ký tự.
    const teacher = { code: "GV01", fullName: "Nguyễn Thị Lan", phone: "", email: "" };
    expect(teacherInput.parse(teacher).shortName).toBeNull();
    expect(teacherInput.parse({ ...teacher, shortName: "  " }).shortName).toBeNull();
    expect(teacherInput.parse({ ...teacher, shortName: " Cô Lan " }).shortName).toBe("Cô Lan");
    expect(teacherInput.safeParse({ ...teacher, shortName: "x".repeat(21) }).success).toBe(false);
  });

  it("mật khẩu và tài khoản", () => {
    expect(password.safeParse("ngan1").success).toBe(false);
    expect(password.safeParse("chicochucai").success).toBe(false);
    expect(password.safeParse("MatKhau12345").success).toBe(true);
    const account = { username: "GV.Lan", name: "Lan", password: "MatKhau12345" };
    expect(accountInput.safeParse({ ...account, role: "teacher", teacherId: "" }).success).toBe(false);
    expect(accountInput.parse({ ...account, role: "admin", teacherId: "" })).toMatchObject({ username: "gv.lan", teacherId: null });
    // Vai trò là khóa trong Cấu hình: khóa sai định dạng bị chặn ở đây, khóa không tồn tại bị chặn ở service.
    expect(accountInput.safeParse({ ...account, role: "Super User!" }).success).toBe(false);
    expect(accountInput.safeParse({ ...account, role: "" }).success).toBe(false);
  });
});

describe("giới hạn tốc độ", () => {
  it("chặn khi hết token và hồi dần theo thời gian", () => {
    resetRateLimits();
    const t0 = 1_000_000;
    expect([1, 2, 3].map(() => consumeToken("k", 3, 1, t0))).toEqual([true, true, true]);
    expect(consumeToken("k", 3, 1, t0)).toBe(false);
    expect(consumeToken("k", 3, 1, t0 + 1000)).toBe(true);
    expect(consumeToken("other", 3, 1, t0)).toBe(true);
  });
});
