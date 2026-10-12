import { afterEach, describe, expect, it, vi } from "vitest";
import { stageNotice } from "@/components/center-3d/overview";
import { AppError } from "@/server/errors";
import { orFallback } from "@/server/page";
import { emptyCenter } from "@/server/services/dashboard";

afterEach(() => vi.restoreAllMocks());

describe("phần dữ liệu phụ của trang lỗi thì trang vẫn mở", () => {
  it("không lỗi: trả đúng kết quả, không ghi log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await orFallback("thử", Promise.resolve({ n: 3 }), null)).toEqual({ n: 3 });
    expect(log).not.toHaveBeenCalled();
  });

  it("lỗi bất ngờ: trả giá trị dự phòng; log chỉ có tên lỗi và mã lỗi của CSDL, không có câu truy vấn hay tham số", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const pg = Object.assign(new Error('relation "rooms" does not exist'), { code: "42P01" });
    const wrapped = Object.assign(new Error("Failed query: select * from rooms where name = $1\nparams: Nguyễn Văn A,0900000000"), { name: "DrizzleQueryError", cause: pg });
    expect(await orFallback("centerToday", Promise.reject(wrapped), null)).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    const written = log.mock.calls[0]!.join(" ");
    expect(written).toContain("centerToday");
    expect(written).toContain("DrizzleQueryError");
    expect(written).toContain('42P01 relation "rooms" does not exist');
    expect(written).not.toContain("Nguyễn Văn A");
    expect(written).not.toContain("0900000000");
    expect(written).not.toContain("select");

    // Lỗi không phải của CSDL: chỉ ghi tên lỗi.
    expect(await orFallback("khác", Promise.reject(new TypeError("chi tiết nội bộ")), "dự phòng")).toBe("dự phòng");
    expect(log.mock.calls[1]!.join(" ")).not.toContain("chi tiết nội bộ");
  });

  it("lỗi phân quyền của service không bị nuốt", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(orFallback("thử", Promise.reject(new AppError("FORBIDDEN", "Không có quyền")), null)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(orFallback("thử", Promise.reject(new AppError("UNAUTHENTICATED", "Vui lòng đăng nhập.")), null)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(log).not.toHaveBeenCalled();
  });

  it("dữ liệu rỗng của cảnh: ngày và giờ Việt Nam tính độc lập, không có phòng và buổi", () => {
    expect(emptyCenter(new Date("2026-01-21T05:07:00Z"))).toEqual({ today: "2026-01-21", now: "12:07", rooms: [], sessions: [] });
    // 17:30 UTC đã sang ngày hôm sau ở Việt Nam.
    expect(emptyCenter(new Date("2026-01-21T17:30:00Z"))).toEqual({ today: "2026-01-22", now: "00:30", rooms: [], sessions: [] });
  });

  it("dòng báo trên trang: chỉ có khi thiếu dữ liệu, nêu đúng phần thiếu", () => {
    expect(stageNotice(false, false)).toBeNull();
    expect(stageNotice(true, false)).toContain("phòng và buổi học hôm nay");
    expect(stageNotice(true, false)).not.toContain("số liệu hôm nay");
    expect(stageNotice(false, true)).toContain("số liệu hôm nay và tuần này");
    expect(stageNotice(true, true)).toContain("phòng và buổi học hôm nay, số liệu hôm nay và tuần này");
  });
});
