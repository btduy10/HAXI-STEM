import "server-only";
import { notFound, unstable_rethrow } from "next/navigation";
import { AppError } from "./errors";

/** Trong trang: lỗi không tìm thấy / không có quyền của service hiển thị thành trang 404. */
export async function orNotFound<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (e) {
    if (e instanceof AppError && (e.code === "NOT_FOUND" || e.code === "FORBIDDEN")) notFound();
    throw e;
  }
}

/** Mã lỗi và thông báo của Postgres (driver có thể bọc trong `cause`), để ghi log mà không kèm câu truy vấn hay tham số. */
function dbDetail(e: unknown): string {
  for (let cur = e as { code?: unknown; cause?: unknown; message?: unknown } | undefined, i = 0; cur && i < 4; cur = cur.cause as typeof cur, i++) {
    if (typeof cur.code === "string" && /^[0-9A-Z]{5}$/.test(cur.code)) return `${cur.code} ${typeof cur.message === "string" ? cur.message.slice(0, 200) : ""}`.trim();
  }
  return "";
}

/**
 * Trong trang: chạy một phần dữ liệu PHỤ (trang vẫn dùng được khi thiếu nó). Lỗi bất ngờ thì ghi log tên lỗi và mã lỗi của CSDL
 * (không ghi câu truy vấn, tham số hay dữ liệu) rồi trả `fallback`, để người dùng vẫn mở được trang. Lỗi phân quyền của service
 * và lỗi điều hướng của Next.js vẫn được ném tiếp như bình thường.
 */
export async function orFallback<T, F>(label: string, promise: Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await promise;
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof AppError) throw e;
    console.error(`[page] ${label} lỗi, dùng dữ liệu dự phòng:`, e instanceof Error ? e.name : "unknown", dbDetail(e));
    return fallback;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tham số đường dẫn phải là UUID, nếu không trả 404 (tránh lỗi ép kiểu ở CSDL). */
export function uuidParam(value: string): string {
  if (!UUID.test(value)) notFound();
  return value;
}

/**
 * Trang buổi học ở khu vực giảng dạy: mở từ Thời khóa biểu (link kèm ?tkb=<ngày>) thì nút Quay lại về đúng tuần đó,
 * còn lại về Tổng quan. Chỉ nhận giá trị đúng dạng ngày để không tạo link tùy ý.
 */
export function teacherSessionBack(raw: string | string[] | undefined): { backHref: string; tabQuery: string } {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return { backHref: "/teacher/dashboard", tabQuery: "" };
  return { backHref: `/teacher/timetable?date=${value}`, tabQuery: `?tkb=${value}` };
}
