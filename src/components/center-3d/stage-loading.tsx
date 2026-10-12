import { BrandLogo } from "@/components/brand-logo";

/** Khung chờ của trang Tổng quan kiểu dashboard 3D, hiện trong lúc máy chủ tải dữ liệu. */
export function StageLoading() {
  return (
    <div role="status" aria-label="Đang tải" className="grid min-h-[70dvh] place-items-center bg-scene-bg p-6 xl:min-h-dvh">
      <div className="grid animate-pulse justify-items-center gap-3">
        <BrandLogo height={72} />
        <p className="text-sm text-ink-soft">Đang tải Tổng quan…</p>
      </div>
    </div>
  );
}
