import { describe, expect, it } from "vitest";
import { previewOrigins, resolveBaseUrl } from "@/server/base-url";

describe("địa chỉ chính của trang và nguồn tin cậy của phần đăng nhập", () => {
  it("địa chỉ chính: ưu tiên BETTER_AUTH_URL, rồi tên miền production của Vercel, rồi URL của Netlify", () => {
    expect(resolveBaseUrl({ BETTER_AUTH_URL: "https://a.example", VERCEL_PROJECT_PRODUCTION_URL: "b.example", URL: "https://c.example" })).toBe("https://a.example");
    expect(resolveBaseUrl({ VERCEL_PROJECT_PRODUCTION_URL: "b.example", URL: "https://c.example" })).toBe("https://b.example");
    expect(resolveBaseUrl({ URL: "https://c.example" })).toBe("https://c.example");
    expect(resolveBaseUrl({})).toBeUndefined();
  });

  it("bản preview của Vercel tin cậy thêm đúng tên miền của chính nó và tên miền của nhánh", () => {
    expect(previewOrigins({ VERCEL_ENV: "preview", VERCEL_URL: "app-abc123.vercel.app", VERCEL_BRANCH_URL: "app-git-nhanh.vercel.app" })).toEqual([
      "https://app-abc123.vercel.app",
      "https://app-git-nhanh.vercel.app",
    ]);
    expect(previewOrigins({ VERCEL_ENV: "preview", VERCEL_URL: "app-abc123.vercel.app" })).toEqual(["https://app-abc123.vercel.app"]);
    expect(previewOrigins({ VERCEL_ENV: "preview" })).toEqual([]);
  });

  it("production, máy phát triển và nền tảng khác: không thêm nguồn tin cậy nào, kể cả khi có sẵn các biến tên miền", () => {
    const hosts = { VERCEL_URL: "app-abc123.vercel.app", VERCEL_BRANCH_URL: "app-git-main.vercel.app" };
    expect(previewOrigins({ VERCEL_ENV: "production", ...hosts })).toEqual([]);
    expect(previewOrigins({ VERCEL_ENV: "development", ...hosts })).toEqual([]);
    expect(previewOrigins(hosts)).toEqual([]);
    expect(previewOrigins({})).toEqual([]);
  });
});
