// Quy tắc thuần của dashboard 3D ở trang Tổng quan: bố trí khuôn viên, trạng thái phòng theo giờ, tiến trình buổi học.
// Mặt bằng là tự xếp theo danh sách phòng, không phải mặt bằng thật. Đơn vị: mét; +X là hướng đông, +Z là hướng nam.

export type CenterRoom = { id: string; name: string; capacity: number };

/** Một buổi hôm nay gửi xuống trình duyệt: không có tên hay thông tin nào của học viên. */
export type CenterSession = {
  id: string;
  classId: string;
  roomId: string | null;
  className: string;
  /** Người thực dạy (giáo viên dạy thay nếu có). */
  teacherId: string | null;
  teacherName: string | null;
  /** "HH:MM" */
  startTime: string;
  endTime: string;
  cancelled: boolean;
  /** Lớp chỉ hiển thị trên Thời khóa biểu (vd. cho mượn phòng): không có sĩ số. */
  timetableOnly: boolean;
  /** Số học viên đang ghi danh của lớp; null khi lớp không theo dõi học viên. */
  studentCount: number | null;
  /** Số lượt điểm danh đã ghi của buổi (0 = chưa điểm danh). */
  attendanceCount: number;
  /** Số lần ghi sao của buổi; luôn 0 với người không có quyền xem Sao. */
  starLogCount: number;
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

// ---------- Các bước của một buổi học và chênh lệch KPI ----------

export type SessionStepKey = "scheduled" | "attendance" | "live" | "stars" | "finished";
export type SessionStepState = "done" | "current" | "pending";
export type SessionStep = {
  key: SessionStepKey;
  label: string;
  state: SessionStepState;
  /** Thời điểm của bước (đã định dạng để hiển thị); null khi bước chưa xảy ra hoặc không rõ. */
  at: string | null;
};

/** Mốc thời gian thật của buổi, đã định dạng để hiển thị; null = chưa có. */
export type SessionTimeline = { scheduledAt: string | null; attendanceAt: string | null; starsAt: string | null };

/**
 * Năm bước của một buổi học hôm nay lúc `now` ("HH:MM"): Lên lịch → Điểm danh → Đang học → Chấm sao → Hoàn tất.
 * - Lên lịch: luôn xong (buổi đã có trên thời khóa biểu).
 * - Điểm danh: xong khi đã ghi điểm danh; tới giờ học mà chưa ghi thì là bước đang chờ làm.
 * - Đang học: đang diễn ra trong giờ học, xong khi hết giờ.
 * - Chấm sao: xong khi đã có lần ghi sao (bước không bắt buộc nên không bao giờ là bước đang chờ).
 * - Hoàn tất: xong khi hết giờ và đã điểm danh; hết giờ mà chưa điểm danh thì còn chờ.
 * Buổi đã hủy: chỉ bước Lên lịch là xong.
 */
export function sessionSteps(
  session: Pick<CenterSession, "startTime" | "endTime" | "cancelled"> & { attended: boolean; starred: boolean },
  now: string,
  timeline?: SessionTimeline | null,
): SessionStep[] {
  const started = !session.cancelled && session.startTime <= now;
  const ended = !session.cancelled && session.endTime <= now;
  const attended = !session.cancelled && session.attended;
  const starred = !session.cancelled && session.starred;
  const state = (done: boolean, current: boolean): SessionStepState => (done ? "done" : current ? "current" : "pending");
  return [
    { key: "scheduled", label: "Lên lịch", state: "done", at: timeline?.scheduledAt ?? null },
    { key: "attendance", label: "Điểm danh", state: state(attended, started), at: attended ? (timeline?.attendanceAt ?? null) : null },
    { key: "live", label: "Đang học", state: state(ended, started), at: started ? session.startTime : null },
    { key: "stars", label: "Chấm sao", state: state(starred, false), at: starred ? (timeline?.starsAt ?? null) : null },
    { key: "finished", label: "Hoàn tất", state: state(ended && attended, ended), at: ended ? session.endTime : null },
  ];
}

export type KpiDelta = { direction: "up" | "down" | "flat"; /** Mức chênh so với kỳ trước, luôn không âm, làm tròn một chữ số thập phân. */ diff: number };

/** Chênh lệch của một số liệu so với kỳ trước; null khi một trong hai kỳ không có dữ liệu. */
export function kpiDelta(current: number | null, previous: number | null): KpiDelta | null {
  if (current === null || previous === null) return null;
  const diff = Math.round((current - previous) * 10) / 10;
  return { direction: diff > 0 ? "up" : diff < 0 ? "down" : "flat", diff: Math.abs(diff) };
}

// ---------- Chuyển động theo thời khóa biểu ----------

/** Quãng thời gian đi bộ: học viên và giáo viên tới cửa phòng trong 3 phút trước giờ học, rời đi trong 3 phút sau giờ học. */
export const WALK_SECONDS = 180;

export type SessionPhase = { phase: "arriving" | "live" | "leaving"; /** Phần đã qua của giai đoạn, từ 0 đến 1. */ t: number };

/**
 * Giai đoạn của một buổi lúc `nowSeconds` (số giây từ đầu ngày, giờ Việt Nam): đang tới (WALK_SECONDS trước giờ bắt đầu),
 * trong giờ, đang về (WALK_SECONDS sau giờ kết thúc). Ngoài các quãng đó và với buổi đã hủy: null (không có ai trước cửa).
 */
export function sessionPhase(session: Pick<CenterSession, "startTime" | "endTime" | "cancelled">, nowSeconds: number): SessionPhase | null {
  if (session.cancelled) return null;
  const start = minutesOf(session.startTime) * 60;
  const end = minutesOf(session.endTime) * 60;
  if (nowSeconds >= start && nowSeconds < end) return { phase: "live", t: end > start ? (nowSeconds - start) / (end - start) : 1 };
  if (nowSeconds >= start - WALK_SECONDS && nowSeconds < start) return { phase: "arriving", t: (nowSeconds - (start - WALK_SECONDS)) / WALK_SECONDS };
  if (nowSeconds >= end && nowSeconds < end + WALK_SECONDS) return { phase: "leaving", t: (nowSeconds - end) / WALK_SECONDS };
  return null;
}

export type PathPoint = { x: number; z: number };

/** Lối đi nằm trong sân, cách mép sân phía các dãy nhà một khoảng này (tránh người đang đứng trước cửa và cây ở góc sân). */
export const LANE_INSET = 2.8;

/** Chỗ đứng trước cửa một phòng, đổi từ tọa độ riêng của tòa nhà (mặt tiền quay về +Z) sang tọa độ khuôn viên. */
export function doorSpot(placement: BuildingPlacement, local: PathPoint): PathPoint {
  return placement.facing === "south" ? { x: placement.x + local.x, z: placement.z + local.z } : { x: placement.x + local.z, z: placement.z - local.x };
}

/**
 * Lộ trình đi bộ từ cổng tới chỗ đứng `slot` trước cửa một phòng. Phòng dãy bắc: vào từ đường phía đông, đi dọc lối phía bắc
 * của sân rồi rẽ vào cửa. Phòng dãy tây: vào từ đường phía nam, đi dọc lối phía tây của sân rồi rẽ vào cửa.
 * Lộ trình chỉ gồm các đoạn thẳng song song với trục, nằm trong sân và lối đi trước cửa (không cắt qua tòa nhà nào).
 */
export function walkPath(campus: Campus, placement: BuildingPlacement, slot: PathPoint): PathPoint[] {
  const { plaza } = campus;
  if (placement.facing === "south") {
    const lane = plaza.z - plaza.depth / 2 + LANE_INSET;
    return [{ x: plaza.x + plaza.width / 2 + 0.6, z: lane }, { x: slot.x, z: lane }, slot];
  }
  const lane = plaza.x - plaza.width / 2 + LANE_INSET;
  return [{ x: lane, z: plaza.z + plaza.depth / 2 + 0.6 }, { x: lane, z: slot.z }, slot];
}

/** Vòng lộ trình hình chữ nhật (đi hết bốn cạnh rồi về điểm đầu) cho robot tuần tra. */
export function loopPath(rect: Rect): PathPoint[] {
  const [minX, maxX, minZ, maxZ] = [rect.x - rect.width / 2, rect.x + rect.width / 2, rect.z - rect.depth / 2, rect.z + rect.depth / 2];
  return [{ x: minX, z: minZ }, { x: maxX, z: minZ }, { x: maxX, z: maxZ }, { x: minX, z: maxZ }, { x: minX, z: minZ }];
}

export const pathLength = (path: PathPoint[]) => path.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - path[index]!.x, point.z - path[index]!.z), 0);

/**
 * Điểm trên lộ trình sau khi đi được phần `t` (0–1) của tổng quãng đường, và hướng đang đi (góc quay quanh trục đứng,
 * 0 = nhìn về +Z). Đi đều theo quãng đường, không theo số đoạn.
 */
export function pointOnPath(path: PathPoint[], t: number): PathPoint & { heading: number } {
  const first = path[0] ?? { x: 0, z: 0 };
  let left = Math.min(1, Math.max(0, t)) * pathLength(path);
  let heading = 0;
  for (let index = 1; index < path.length; index++) {
    const [from, to] = [path[index - 1]!, path[index]!];
    const length = Math.hypot(to.x - from.x, to.z - from.z);
    if (length === 0) continue;
    heading = Math.atan2(to.x - from.x, to.z - from.z);
    if (left <= length) return { x: from.x + ((to.x - from.x) * left) / length, z: from.z + ((to.z - from.z) * left) / length, heading };
    left -= length;
  }
  const last = path.at(-1) ?? first;
  return { x: last.x, z: last.z, heading };
}

/** Tâm sa bàn thi đấu ở giữa sân. */
export const arenaSpot = (campus: Campus): PathPoint => ({ x: campus.plaza.x + 0.5, z: campus.plaza.z + 0.8 });

/** Các vòng tuần tra của ba robot trang trí: dọc mép nam của sân, dọc mép đông của sân, và quanh sa bàn. */
export function robotLoops(campus: Campus): Rect[] {
  const { plaza } = campus;
  const arena = arenaSpot(campus);
  const [maxX, minZ, maxZ] = [plaza.x + plaza.width / 2, plaza.z - plaza.depth / 2, plaza.z + plaza.depth / 2];
  const eastFrom = minZ + LANE_INSET + 1.4;
  const eastTo = Math.max(eastFrom + 2, plaza.z + 1);
  return [
    { x: plaza.x + 0.4, z: maxZ - 2.1, width: plaza.width - 7.6, depth: 1 },
    { x: maxX - 1.5, z: (eastFrom + eastTo) / 2, width: 0.8, depth: eastTo - eastFrom },
    { x: arena.x, z: arena.z, width: 6.6, depth: 5.2 },
  ];
}
