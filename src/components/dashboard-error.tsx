"use client";

import { RotateCwIcon } from "lucide-react";

/**
 * Hiện khi trang Tổng quan gặp lỗi lúc dựng: thay vì trang lỗi trắng của cả ứng dụng, người dùng vẫn thấy menu và đi tiếp
 * được sang các mục khác. Không hiện chi tiết lỗi; chỉ có mã đối chiếu (digest) để tìm đúng dòng trong nhật ký máy chủ.
 */
export function DashboardError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="grid min-h-[60dvh] place-items-center p-4">
      <div role="alert" className="grid max-w-md justify-items-start gap-3 rounded-3xl border bg-card p-6 shadow-sm">
        <h1 className="text-xl font-semibold">Chưa mở được trang Tổng quan</h1>
        <p className="text-sm text-muted-foreground">
          Máy chủ gặp lỗi khi tải dữ liệu của trang này. Các mục khác trong menu vẫn dùng bình thường. Bạn thử lại sau ít phút; nếu vẫn lỗi, báo quản trị
          viên kèm mã bên dưới.
        </p>
        <button
          type="button"
          onClick={() => retry()}
          className="flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground outline-none hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <RotateCwIcon className="size-4" aria-hidden />
          Thử lại
        </button>
        {error.digest && <p className="text-xs text-muted-foreground">Mã lỗi: {error.digest}</p>}
      </div>
    </div>
  );
}
