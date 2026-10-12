"use client";

import { CheckIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { type Campus, ROOM_STATE_LABELS, type Rect } from "@/domain/center-3d";
import { cn } from "@/lib/utils";
import type { SceneInsets, SceneRoom } from "./center-scene";
import { STATE_DOT } from "./theme";

const STATE_FILL = {
  live: "border-state-live bg-primary-soft",
  upcoming: "border-state-upcoming bg-brand-gold-soft",
  done: "border-state-done bg-card",
  idle: "border-state-idle bg-card",
} as const;

/**
 * "Giao diện nhẹ": sơ đồ 2D nhìn từ trên xuống của khuôn viên, vẽ bằng HTML thường từ cùng mặt bằng với cảnh 3D (`layoutCampus`).
 * Dùng cho máy yếu, khi trình duyệt không chạy được WebGL, hoặc khi người dùng tự chọn; không tải thư viện 3D.
 * Mỗi phòng là một nút tô màu theo trạng thái; bấm để chọn như ở cảnh 3D.
 */
export function CenterFlat({
  campus,
  rooms,
  selectedId,
  onSelect,
  insets,
}: {
  campus: Campus;
  rooms: SceneRoom[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  insets: SceneInsets;
}) {
  const { bounds } = campus;
  const [minX, minZ] = [bounds.x - bounds.width / 2, bounds.z - bounds.depth / 2];
  // Vị trí theo phần trăm của khung sơ đồ: sơ đồ co giãn theo khung mà không cần tính lại.
  const box = (rect: Rect): CSSProperties => ({
    left: `${((rect.x - rect.width / 2 - minX) / bounds.width) * 100}%`,
    top: `${((rect.z - rect.depth / 2 - minZ) / bounds.depth) * 100}%`,
    width: `${(rect.width / bounds.width) * 100}%`,
    height: `${(rect.depth / bounds.depth) * 100}%`,
  });
  const itemOf = new Map(rooms.map((item) => [item.room.id, item]));
  const ratio = bounds.width / bounds.depth;
  return (
    <div
      data-center-flat
      className="absolute grid place-items-center [container-type:size]"
      style={{ top: insets.top + 12, right: insets.right + 12, bottom: insets.bottom + 12, left: insets.left + 12 }}
    >
      <div
        role="group"
        aria-label="Sơ đồ trung tâm (giao diện nhẹ)"
        className="relative overflow-hidden rounded-3xl border bg-(--scene-ground)"
        style={{ aspectRatio: String(ratio), width: `min(100cqw, calc(100cqh * ${ratio}))` }}
      >
        <div aria-hidden className="absolute rounded-xl border border-(--scene-road-line) bg-(--scene-plaza)" style={box(campus.plaza)} />
        {[campus.roads.south, campus.roads.east].map((road, index) => (
          <div key={index} aria-hidden className="absolute bg-(--scene-road)" style={box(road)} />
        ))}
        <div aria-hidden className="absolute grid place-items-center rounded-lg border-2 border-primary bg-(--scene-wall) p-1" style={box(campus.main)}>
          <BrandLogo height={28} />
        </div>
        {campus.rooms.map((placement) => {
          const item = itemOf.get(placement.id);
          if (!item) return null;
          const { room, state, session } = item;
          const shown = session && state !== "done" ? session : null;
          const selected = room.id === selectedId;
          return (
            <button
              key={room.id}
              type="button"
              data-flat-room={room.name}
              data-state={state}
              aria-pressed={selected}
              onClick={() => onSelect(room.id)}
              style={box(placement)}
              className={cn(
                "absolute grid content-center gap-0.5 overflow-hidden rounded-lg border-2 px-1 py-0.5 text-left text-[0.625rem] leading-tight text-foreground outline-none transition-shadow hover:shadow-panel focus-visible:ring-3 focus-visible:ring-ring/60",
                STATE_FILL[state],
                selected && "ring-3 ring-brand-teal",
              )}
            >
              <span className="flex items-start gap-1 font-semibold">
                <span aria-hidden className={cn("mt-0.5 size-2 shrink-0 rounded-full", STATE_DOT[state])} />
                <span className="line-clamp-2 min-w-0 break-words">
                  {room.name}
                  <span className="sr-only">{`: ${shown ? `${ROOM_STATE_LABELS[state]}, ` : ""}`}</span>
                </span>
                {(session?.attendanceCount ?? 0) > 0 && state !== "idle" && <CheckIcon className="size-3 shrink-0 text-primary" strokeWidth={3} aria-label="đã điểm danh" />}
              </span>
              <span className="truncate text-ink-soft">{shown ? `${shown.startTime} · ${shown.className}` : ROOM_STATE_LABELS[state]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
