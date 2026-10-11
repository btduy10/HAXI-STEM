import { isAuthorizedCron } from "@/server/cron";
import { topUpSessions } from "@/server/services/sessions";

/**
 * Tác vụ hằng ngày (Vercel Cron, xem vercel.json): bổ sung buổi học còn thiếu từ hôm nay đến hết tuần sau
 * cho mọi lớp đang mở có lịch mẫu. Chỉ trả về số liệu tổng, không có dữ liệu cá nhân.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) return Response.json({ ok: false }, { status: 401 });
  try {
    const { range, classCount, created } = await topUpSessions();
    return Response.json({ ok: true, from: range.from, to: range.to, classes: classCount, created });
  } catch (e) {
    console.error("[cron] generate-sessions:", e instanceof Error ? e.name : "unknown");
    return Response.json({ ok: false }, { status: 500 });
  }
}
