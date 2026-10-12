import type { RoomState } from "@/domain/center-3d";

// Màu của cảnh 3D lấy từ các CSS variable ở `:root` (src/app/globals.css): một nguồn màu chung cho giao diện và vật liệu 3D.
const TOKENS = {
  ground: "--scene-ground",
  plaza: "--scene-plaza",
  road: "--scene-road",
  roadLine: "--scene-road-line",
  wall: "--scene-wall",
  trim: "--scene-trim",
  roof: "--scene-roof",
  door: "--scene-door",
  glass: "--scene-glass",
  tree: "--scene-tree",
  trunk: "--scene-trunk",
  wood: "--scene-wood",
  skin: "--scene-skin",
  ink: "--scene-ink",
  white: "--scene-white",
  teal: "--scene-teal",
  gold: "--brand-gold",
  goldSoft: "--brand-gold-soft",
  primarySoft: "--primary-soft",
  live: "--state-live",
  upcoming: "--state-upcoming",
  done: "--state-done",
  idle: "--state-idle",
} as const;

export type SceneTheme = Record<keyof typeof TOKENS, string>;

/** Đọc bảng màu của cảnh từ CSS variable (giá trị đã được trình duyệt thay hết `var()`). Chỉ gọi ở trình duyệt. */
export function readSceneTheme(): SceneTheme {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(Object.entries(TOKENS).map(([key, name]) => [key, style.getPropertyValue(name).trim()])) as SceneTheme;
}

/** Màu điểm nhấn của một phòng theo trạng thái. */
export const stateColor = (theme: SceneTheme, state: RoomState) => theme[state];

/** Lớp nền (Tailwind) của chấm màu trạng thái trên các thẻ HTML. */
export const STATE_DOT: Record<RoomState, string> = {
  live: "bg-state-live",
  upcoming: "bg-state-upcoming",
  done: "bg-state-done",
  idle: "bg-state-idle",
};
