import { describe, expect, it } from "vitest";
import { canAssignMakeup, isAbsence, makeupState } from "@/domain/makeup";
import { nextStudentCode } from "@/domain/student-code";
import { newEnrollmentInput } from "@/lib/validation/entities";

describe("mã học viên tự cấp", () => {
  it("HX + 2 số cuối của năm + số thứ tự, bắt đầu từ 01", () => {
    expect(nextStudentCode([], 2026)).toBe("HX2601");
    expect(nextStudentCode(["HX2601", "HX2602"], 2026)).toBe("HX2603");
    // Lấy số lớn nhất cộng 1, không lấp chỗ trống ở giữa.
    expect(nextStudentCode(["HX2601", "HX2609"], 2026)).toBe("HX2610");
  });

  it("mỗi năm đếm lại từ đầu; quá 99 thì thêm chữ số", () => {
    expect(nextStudentCode(["HX2601", "HX2657"], 2027)).toBe("HX2701");
    expect(nextStudentCode(["HX2699"], 2026)).toBe("HX26100");
    expect(nextStudentCode(["HX26100", "HX2699"], 2026)).toBe("HX26101");
    expect(nextStudentCode([], 2009)).toBe("HX0901");
  });

  it("bỏ qua mã không đúng mẫu (mã cũ nhập tay, mã có chữ ở cuối)", () => {
    expect(nextStudentCode(["HV001", "HX26A1", "HX265", "hx2604 ", "HX2603-B"], 2026)).toBe("HX2605");
  });

  it("form học viên mới không có ô mã: mã gửi kèm (kể cả mã sai mẫu) bị bỏ qua, máy chủ tự cấp", () => {
    expect(newEnrollmentInput.parse({ fullName: "An", schoolGrade: "", classId: "none" })).not.toHaveProperty("code");
    expect(newEnrollmentInput.parse({ code: "HX2699", fullName: "An", schoolGrade: "", classId: "none" })).not.toHaveProperty("code");
    expect(newEnrollmentInput.safeParse({ code: "HX 26", fullName: "An", schoolGrade: "", classId: "none" }).success).toBe(true);
  });

  it("học viên mới ở Ghi danh: không chọn lớp thì vào danh sách chờ; có lớp thì phải có ngày vào lớp", () => {
    const classId = "0b8a3f0e-7d0c-4c5e-9a53-0c1d2e3f4a5b";
    expect(newEnrollmentInput.parse({ fullName: "An", schoolGrade: "", classId: "none", joinedAt: "2026-01-13" })).toMatchObject({ classId: null });
    expect(newEnrollmentInput.parse({ fullName: "An", schoolGrade: "", classId: "" }).classId).toBeNull();
    expect(newEnrollmentInput.parse({ fullName: "An", schoolGrade: "", classId, joinedAt: "2026-01-13" })).toMatchObject({ classId, joinedAt: "2026-01-13", status: "active" });
    expect(newEnrollmentInput.safeParse({ fullName: "An", schoolGrade: "", classId, joinedAt: "" }).success).toBe(false);
    expect(newEnrollmentInput.safeParse({ fullName: "An", schoolGrade: "", classId: "abc" }).success).toBe(false);
  });
});

describe("trạng thái học bù của một buổi vắng", () => {
  it("chỉ vắng có phép và vắng không phép mới cần học bù", () => {
    expect(isAbsence("absent")).toBe(true);
    expect(isAbsence("excused")).toBe(true);
    expect(["present", "late", "left_early"].some((s) => isAbsence(s as "present"))).toBe(false);
  });

  it("chưa xếp → đã xếp → đã bù; vắng buổi bù hoặc buổi bù bị hủy thì xếp lại được", () => {
    expect(makeupState(null)).toBe("pending");
    expect(makeupState({ sessionStatus: "planned", attendance: null })).toBe("scheduled");
    expect(makeupState({ sessionStatus: "done", attendance: "present" })).toBe("done");
    expect(makeupState({ sessionStatus: "done", attendance: "late" })).toBe("done");
    expect(makeupState({ sessionStatus: "done", attendance: "absent" })).toBe("missed");
    expect(makeupState({ sessionStatus: "done", attendance: "excused" })).toBe("missed");
    expect(makeupState({ sessionStatus: "cancelled", attendance: null })).toBe("cancelled");
    expect((["pending", "scheduled", "done", "missed", "cancelled"] as const).filter(canAssignMakeup)).toEqual(["pending", "missed", "cancelled"]);
  });
});
