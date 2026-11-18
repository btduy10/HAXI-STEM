import { describe, expect, it } from "vitest";
import { isUuid, paramChoice, paramDate, paramId, paramText } from "@/lib/search-params";

const ID = "0b8e4f5c-1d2a-4c3b-9e8f-7a6b5c4d3e2f";

describe("đọc tham số trên địa chỉ trang", () => {
  it("lấy giá trị đầu khi tham số lặp lại; thiếu (undefined của trang, null của route) thì rỗng", () => {
    expect(paramText(["a", "b"])).toBe("a");
    expect(paramText(undefined)).toBe("");
    expect(paramText(null)).toBe("");
    expect(paramText([])).toBe("");
  });

  it("chuỗi bị cắt theo độ dài tối đa (mặc định 100)", () => {
    expect(paramText("x".repeat(150))).toHaveLength(100);
    expect(paramText("hành động dài", 4)).toBe("hành");
  });

  it("mã chỉ nhận UUID đủ và đúng dạng, không cắt bớt để thành hợp lệ", () => {
    expect(paramId(ID)).toBe(ID);
    expect(paramId([ID, "khác"])).toBe(ID);
    expect(paramId(`${ID}abc`)).toBeNull();
    expect(paramId("1 or 1=1")).toBeNull();
    expect(paramId(null)).toBeNull();
    expect(isUuid(ID.toUpperCase())).toBe(true);
  });

  it("ngày phải có thật, không thì dùng giá trị mặc định", () => {
    expect(paramDate("2026-02-28", "mặc định")).toBe("2026-02-28");
    expect(paramDate("2026-02-30", "mặc định")).toBe("mặc định");
    expect(paramDate("2026-02-28xyz", "mặc định")).toBe("mặc định");
    expect(paramDate(undefined, "")).toBe("");
  });

  it("chỉ nhận giá trị trong danh sách cho phép", () => {
    expect(paramChoice("month", ["week", "month"] as const, "week")).toBe("month");
    expect(paramChoice("year", ["week", "month"] as const, "week")).toBe("week");
    expect(paramChoice(undefined, ["paid"] as const, null)).toBeNull();
  });
});
