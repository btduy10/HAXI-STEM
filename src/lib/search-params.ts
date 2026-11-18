import { parseIsoDate } from "./dates";

/**
 * Đọc tham số trên địa chỉ trang. Nhận đúng giá trị Next.js và Web API đưa ra: `searchParams[key]` của trang
 * (chuỗi, mảng khi tham số lặp lại, hoặc undefined) hay `URLSearchParams.get(key)` của route (chuỗi hoặc null).
 * Luôn lấy giá trị đầu, giới hạn độ dài, kiểm tra định dạng; sai thì trả giá trị mặc định, không bao giờ ném lỗi.
 */
export type RawParam = string | string[] | null | undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string) => UUID.test(value);

const first = (raw: RawParam) => (Array.isArray(raw) ? raw[0] : raw) ?? "";

/** Chuỗi, cắt còn `max` ký tự (mặc định 100); thiếu thì "". */
export function paramText(raw: RawParam, max = 100): string {
  return first(raw).slice(0, max);
}

/** Mã UUID (tránh truy vấn với giá trị tùy ý); thiếu hoặc sai định dạng thì null. */
export function paramId(raw: RawParam): string | null {
  const value = first(raw);
  return isUuid(value) ? value : null;
}

/** Ngày "yyyy-mm-dd" có thật; thiếu hoặc sai thì `fallback`. */
export function paramDate(raw: RawParam, fallback: string): string {
  return parseIsoDate(first(raw), fallback);
}

/** Một trong các giá trị cho phép; không thì `fallback`. */
export function paramChoice<T extends string, F extends string | null>(raw: RawParam, allowed: readonly T[], fallback: F): T | F {
  const value = paramText(raw);
  return allowed.find((item) => item === value) ?? fallback;
}
