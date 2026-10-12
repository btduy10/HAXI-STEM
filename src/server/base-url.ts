type Env = Record<string, string | undefined>;

/**
 * Địa chỉ chính của trang. Ưu tiên BETTER_AUTH_URL; nếu chưa đặt thì lấy địa chỉ production
 * do nền tảng cung cấp (Vercel: VERCEL_PROJECT_PRODUCTION_URL không kèm giao thức; Netlify: URL).
 */
export function resolveBaseUrl(env: Env = process.env): string | undefined {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL;
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return env.URL;
}

/**
 * Nguồn được tin cậy thêm cho phần đăng nhập, CHỈ ở bản preview của Vercel (VERCEL_ENV = "preview"): tên miền của chính bản
 * preview đó (VERCEL_URL) và tên miền cố định của nhánh (VERCEL_BRANCH_URL), đều do Vercel đặt, người dùng không gửi lên được.
 * Thiếu chúng thì bản preview từ chối mọi lần đăng nhập ("Invalid origin") vì địa chỉ chính của trang là tên miền production.
 * Bản production và nơi khác: không thêm gì.
 */
export function previewOrigins(env: Env = process.env): string[] {
  if (env.VERCEL_ENV !== "preview") return [];
  return [env.VERCEL_URL, env.VERCEL_BRANCH_URL].filter((host): host is string => Boolean(host)).map((host) => `https://${host}`);
}
