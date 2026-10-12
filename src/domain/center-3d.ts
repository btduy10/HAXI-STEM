// Quy tắc thuần của giao diện 3D trung tâm (trang Tổng quan): bố trí phòng, chỗ ngồi và trạng thái phòng theo giờ.
// Mặt bằng là tự xếp theo danh sách phòng, không phải mặt bằng thật. Đơn vị: mét; trục X dọc hành lang, trục Z ngang hành lang.

export type CenterRoom = { id: string; name: string; capacity: number };

/** Một buổi hôm nay gửi xuống trình duyệt: không có tên hay thông tin nào của học viên. */
export type CenterSession = {
  id: string;
  roomId: string | null;
  className: string;
  /** Người thực dạy (giáo viên dạy thay nếu có). */
  teacherName: string | null;
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  cancelled: boolean;
  /** Lớp chỉ hiển thị trên Thời khóa biểu (vd. cho mượn phòng): không có sĩ số. */
  timetableOnly: boolean;
  /** Số học viên đang ghi danh của lớp; null khi lớp không theo dõi học viên. */
  studentCount: number | null;
  /** Trang mở buổi học; null khi buổi không bấm vào được. */
  href: string | null;
};

export type CenterData = {
  /** "yyyy-mm-dd" theo giờ Việt Nam. */
  today: string;
  /** Giờ hiện tại "HH:MM" lúc máy chủ dựng trang (trình duyệt tự cập nhật tiếp). */
  now: string;
  rooms: CenterRoom[];
  sessions: CenterSession[];
};

export const CORRIDOR_WIDTH = 3;
export const ROOM_DEPTH = 6;
export const ROOM_GAP = 0.8;
const ROOM_MIN_WIDTH = 5;
const ROOM_MAX_WIDTH = 9;
/** Số chỗ ngồi tối đa được vẽ trong một phòng (phòng lớn hơn vẫn ghi đúng sức chứa trên nhãn). */
export const MAX_SEATS = 24;

/** Bề ngang phòng (dọc hành lang) theo sức chứa, trong giới hạn để phòng nhỏ không quá hẹp, phòng lớn không quá dài. */
export function roomWidth(capacity: number): number {
  return Math.min(ROOM_MAX_WIDTH, Math.max(ROOM_MIN_WIDTH, 4 + capacity * 0.25));
}

export type RoomPlacement = {
  id: string;
  /** Tâm phòng. */
  x: number;
  z: number;
  width: number;
  depth: number;
  /** Dãy phòng: -1 = phía sau hành lang, 1 = phía trước. Cửa phòng quay về hành lang. */
  side: -1 | 1;
};

/**
 * Xếp phòng thành hai dãy dọc một hành lang, theo thứ tự danh sách: phòng kế tiếp vào dãy đang ngắn hơn
 * (bằng nhau thì dãy sau). Kết quả canh giữa quanh x = 0; `length` là chiều dài dãy dài nhất.
 */
export function layoutRooms(rooms: CenterRoom[]): { rooms: RoomPlacement[]; length: number } {
  const cursor = { [-1]: 0, [1]: 0 } as Record<-1 | 1, number>;
  const placed = rooms.map((room): RoomPlacement => {
    const side: -1 | 1 = cursor[1] < cursor[-1] ? 1 : -1;
    const width = roomWidth(room.capacity);
    const start = cursor[side] === 0 ? 0 : cursor[side] + ROOM_GAP;
    cursor[side] = start + width;
    return { id: room.id, x: start + width / 2, z: side * (CORRIDOR_WIDTH / 2 + ROOM_DEPTH / 2), width, depth: ROOM_DEPTH, side };
  });
  const length = Math.max(cursor[-1], cursor[1]);
  return { rooms: placed.map((room) => ({ ...room, x: room.x - length / 2 })), length };
}

/**
 * Vị trí các chỗ ngồi trong phòng, tính từ tâm phòng: lưới bàn nằm ở phần phòng phía cửa, chừa khoảng trước bảng.
 * `x` dọc hành lang; `z` âm là phía cửa, dương là phía bảng (người gọi tự lật theo dãy phòng).
 */
export function seatPositions(width: number, depth: number, capacity: number): { x: number; z: number }[] {
  const count = Math.min(Math.max(Math.floor(capacity), 0), MAX_SEATS);
  if (count === 0) return [];
  const usableWidth = width - 1.2;
  // Chừa 1,8 m trước bảng cho giáo viên và 0,6 m sát tường phía cửa.
  const usableDepth = depth - 2.4;
  const columns = Math.min(count, Math.max(1, Math.round(Math.sqrt((count * usableWidth) / usableDepth))));
  const rows = Math.ceil(count / columns);
  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      x: columns === 1 ? 0 : -usableWidth / 2 + (usableWidth * column) / (columns - 1),
      z: -depth / 2 + 0.6 + (rows === 1 ? usableDepth / 2 : (usableDepth * row) / (rows - 1)),
    };
  });
}

export type RoomState = "live" | "upcoming" | "done" | "idle";

/**
 * Trạng thái một phòng lúc `now` ("HH:MM") từ các buổi hôm nay của phòng, và buổi được ghi trên nhãn:
 * - "live": đang có buổi (bắt đầu ≤ now < kết thúc);
 * - "upcoming": chưa tới buổi kế tiếp trong ngày;
 * - "done": các buổi hôm nay đã xong (ghi buổi cuối);
 * - "idle": hôm nay không có buổi nào. Buổi đã hủy không tính.
 */
export function roomStatus(sessions: CenterSession[], now: string): { state: RoomState; session: CenterSession | null } {
  const held = sessions.filter((s) => !s.cancelled).sort((a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime));
  const live = held.find((s) => s.startTime <= now && now < s.endTime);
  if (live) return { state: "live", session: live };
  const next = held.find((s) => s.startTime > now);
  if (next) return { state: "upcoming", session: next };
  const last = held.at(-1);
  return last ? { state: "done", session: last } : { state: "idle", session: null };
}

export const ROOM_STATE_LABELS: Record<RoomState, string> = {
  live: "Đang học",
  upcoming: "Sắp học",
  done: "Đã học xong",
  idle: "Trống",
};
