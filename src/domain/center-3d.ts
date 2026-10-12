// Quy tắc thuần của dashboard 3D ở trang Tổng quan: bố trí khuôn viên, trạng thái phòng theo giờ, tiến trình buổi học.
// Mặt bằng là tự xếp theo danh sách phòng, không phải mặt bằng thật. Đơn vị: mét; +X là hướng đông, +Z là hướng nam.

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

// ---------- Bố trí khuôn viên ----------

/** Hình chữ nhật trên mặt đất: tâm (x, z), `width` theo trục X, `depth` theo trục Z. */
export type Rect = { x: number; z: number; width: number; depth: number };

export type BuildingPlacement = Rect & {
  id: string;
  /** Hướng của cửa: dãy phía bắc quay cửa về nam, dãy phía tây quay cửa về đông (cùng nhìn ra sân). */
  facing: "south" | "east";
  /** Bề ngang mặt tiền (cạnh có cửa). */
  front: number;
};

export type Campus = {
  rooms: BuildingPlacement[];
  /** Tòa nhà chính ở góc tây bắc, mặt tiền quay về nam. */
  main: Rect;
  /** Sân trung tâm, mở về phía đông nam. */
  plaza: Rect;
  roads: { south: Rect; east: Rect };
  /** Toàn bộ nền của khuôn viên; tâm luôn ở gốc tọa độ. */
  bounds: Rect;
};

export const MAIN_WIDTH = 11;
export const MAIN_DEPTH = 8;
export const ROOM_DEPTH = 6.5;
export const BUILDING_GAP = 2;
/** Lối đi giữa mặt tiền các tòa nhà và sân. */
export const APRON = 2;
export const ROAD_WIDTH = 4;
const PLAZA_MIN = 14;
const MARGIN = 2.5;
const FRONT_MIN = 6;
const FRONT_MAX = 9;

/** Bề ngang mặt tiền của phòng theo sức chứa, trong giới hạn để phòng nhỏ không quá hẹp, phòng lớn không quá dài. */
export function roomFront(capacity: number): number {
  return Math.min(FRONT_MAX, Math.max(FRONT_MIN, 5.5 + capacity * 0.15));
}

/**
 * Xếp khuôn viên: tòa nhà chính ở góc tây bắc; các phòng theo thứ tự danh sách lần lượt vào dãy phía bắc (cửa quay về nam)
 * và dãy phía tây (cửa quay về đông), mọi cửa cùng nhìn ra sân trung tâm ở phía đông nam; hai con đường viền mép nam và mép
 * đông của sân. Nhìn từ hướng đông nam thấy được mọi mặt tiền. Kết quả canh giữa quanh gốc tọa độ.
 */
export function layoutCampus(rooms: CenterRoom[]): Campus {
  // Tọa độ tạm: góc tây bắc của tòa nhà chính ở (0, 0).
  let northCursor = MAIN_WIDTH;
  let westCursor = MAIN_DEPTH;
  const placed = rooms.map((room, index): BuildingPlacement => {
    const front = roomFront(room.capacity);
    if (index % 2 === 0) {
      const start = northCursor + BUILDING_GAP;
      northCursor = start + front;
      return { id: room.id, facing: "south", front, x: start + front / 2, z: MAIN_DEPTH - ROOM_DEPTH / 2, width: front, depth: ROOM_DEPTH };
    }
    const start = westCursor + BUILDING_GAP;
    westCursor = start + front;
    return { id: room.id, facing: "east", front, x: MAIN_WIDTH - ROOM_DEPTH / 2, z: start + front / 2, width: ROOM_DEPTH, depth: front };
  });

  const plazaMinX = MAIN_WIDTH + APRON;
  const plazaMinZ = MAIN_DEPTH + APRON;
  const plazaMaxX = Math.max(northCursor, plazaMinX + PLAZA_MIN);
  const plazaMaxZ = Math.max(westCursor, plazaMinZ + PLAZA_MIN);
  const minX = -MARGIN;
  const minZ = -MARGIN;
  const maxX = plazaMaxX + 1 + ROAD_WIDTH + MARGIN;
  const maxZ = plazaMaxZ + 1 + ROAD_WIDTH + MARGIN;
  const [shiftX, shiftZ] = [(minX + maxX) / 2, (minZ + maxZ) / 2];
  const rect = (fromX: number, toX: number, fromZ: number, toZ: number): Rect => ({
    x: (fromX + toX) / 2 - shiftX,
    z: (fromZ + toZ) / 2 - shiftZ,
    width: toX - fromX,
    depth: toZ - fromZ,
  });

  return {
    rooms: placed.map((room) => ({ ...room, x: room.x - shiftX, z: room.z - shiftZ })),
    main: rect(0, MAIN_WIDTH, 0, MAIN_DEPTH),
    plaza: rect(plazaMinX, plazaMaxX, plazaMinZ, plazaMaxZ),
    roads: {
      // Hai con đường gặp nhau ở góc đông nam; đường nam chạy hết chiều ngang, đường đông dừng ở mép đường nam.
      south: rect(minX, maxX, plazaMaxZ + 1, plazaMaxZ + 1 + ROAD_WIDTH),
      east: rect(plazaMaxX + 1, plazaMaxX + 1 + ROAD_WIDTH, minZ, plazaMaxZ + 1),
    },
    bounds: rect(minX, maxX, minZ, maxZ),
  };
}

// ---------- Trạng thái phòng và tiến trình buổi học ----------

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

/** "HH:MM" → số phút từ đầu ngày. */
export const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Phần đã trôi qua của một buổi lúc `now`, từ 0 (chưa bắt đầu) đến 1 (đã kết thúc). */
export function sessionProgress(session: Pick<CenterSession, "startTime" | "endTime">, now: string): number {
  const [start, end, at] = [minutesOf(session.startTime), minutesOf(session.endTime), minutesOf(now)];
  if (end <= start) return at >= end ? 1 : 0;
  return Math.min(1, Math.max(0, (at - start) / (end - start)));
}

export type DayProgress = {
  /** Số buổi hôm nay không bị hủy. */
  total: number;
  done: number;
  live: number;
  upcoming: number;
  cancelled: number;
  /** Phần trăm tiến trình của ngày: buổi đã xong tính trọn, buổi đang học tính theo thời gian đã trôi qua. */
  percent: number;
};

/** Tiến trình các buổi học hôm nay lúc `now` ("HH:MM"). */
export function dayProgress(sessions: CenterSession[], now: string): DayProgress {
  const held = sessions.filter((s) => !s.cancelled);
  const done = held.filter((s) => s.endTime <= now);
  const live = held.filter((s) => s.startTime <= now && now < s.endTime);
  const passed = done.length + live.reduce((sum, s) => sum + sessionProgress(s, now), 0);
  return {
    total: held.length,
    done: done.length,
    live: live.length,
    upcoming: held.length - done.length - live.length,
    cancelled: sessions.length - held.length,
    percent: held.length === 0 ? 0 : Math.round((passed / held.length) * 100),
  };
}
