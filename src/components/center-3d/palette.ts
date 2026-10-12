import type { RoomState } from "@/domain/center-3d";

/** Màu của phòng theo trạng thái, dùng chung cho cảnh 3D và bảng danh sách phòng. `accent` đủ đậm để làm chấm màu, viền. */
export const ROOM_COLORS: Record<RoomState, { floor: string; accent: string }> = {
  live: { floor: "#bfe8d3", accent: "#2e7d5b" },
  upcoming: { floor: "#fbe4a8", accent: "#d99a06" },
  done: { floor: "#e9edf0", accent: "#8f9daa" },
  idle: { floor: "#f5f7f8", accent: "#aab6c0" },
};

export const NAVY = "#0e2841";
export const TEAL = "#2e7d5b";
/** Màu áo của các hình người (học viên) trong phòng đang học. */
export const FIGURE_COLORS = ["#4dd0c0", "#f2b84b", "#5b8def", "#ef8a62"] as const;
