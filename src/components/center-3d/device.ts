// Khả năng đồ họa của máy đang mở trang, để chọn giữa cảnh 3D và "Giao diện nhẹ" (sơ đồ 2D). Chỉ gọi ở trình duyệt.
// Tệp này không được import three.js: nó được dùng để quyết định CÓ tải thư viện 3D hay không.

export type Graphics = "full" | "low" | "none";

let cached: Graphics | null = null;

/**
 * - "none": trình duyệt không tạo được WebGL (cảnh 3D không chạy được);
 * - "low": máy yếu theo trình duyệt báo (ít nhân xử lý hoặc ít bộ nhớ): mặc định dùng giao diện nhẹ, cảnh 3D tắt bóng đổ và chuyển động;
 * - "full": còn lại.
 */
export function graphics(): Graphics {
  if (cached) return cached;
  let webgl = false;
  try {
    const canvas = document.createElement("canvas");
    webgl = Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    webgl = false;
  }
  const device = navigator as Navigator & { deviceMemory?: number };
  const low = (device.hardwareConcurrency ?? 8) <= 4 || (device.deviceMemory ?? 8) <= 4;
  cached = !webgl ? "none" : low ? "low" : "full";
  return cached;
}

const VIEW_KEY = "haxi.dashboard.view";
const VIEW_EVENT = "haxi:dashboard-view";
export type ViewChoice = "3d" | "flat";

/** Lựa chọn giao diện của người dùng trên trình duyệt này (chỉ là tùy chọn hiển thị); null = chưa chọn. */
export function readView(): ViewChoice | null {
  try {
    const value = window.localStorage.getItem(VIEW_KEY);
    return value === "3d" || value === "flat" ? value : null;
  } catch {
    return null;
  }
}

export function writeView(value: ViewChoice) {
  try {
    window.localStorage.setItem(VIEW_KEY, value);
  } catch {
    // Trình duyệt chặn lưu trữ: lựa chọn chỉ có hiệu lực tới khi tải lại trang.
  }
  window.dispatchEvent(new CustomEvent(VIEW_EVENT, { detail: value }));
}

/** Đăng ký nghe lựa chọn giao diện đổi (ở tab này hoặc tab khác). */
export function subscribeView(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(VIEW_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(VIEW_EVENT, onChange);
  };
}
