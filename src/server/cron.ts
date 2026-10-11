import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Tác vụ hẹn giờ không có phiên đăng nhập: chỉ chấp nhận yêu cầu kèm "Authorization: Bearer <CRON_SECRET>"
 * (Vercel Cron tự gửi khi biến môi trường CRON_SECRET được khai báo). Chưa khai báo khóa thì luôn từ chối.
 * So sánh trên giá trị băm, thời gian không phụ thuộc nội dung và độ dài khóa.
 */
export function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const given = request.headers.get("authorization") ?? "";
  return timingSafeEqual(digest(given), digest(`Bearer ${secret}`));
}
