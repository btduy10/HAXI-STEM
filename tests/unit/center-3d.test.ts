import { describe, expect, it } from "vitest";
import {
  APRON,
  BUILDING_GAP,
  type CenterSession,
  MAIN_DEPTH,
  MAIN_WIDTH,
  ROOM_DEPTH,
  type Rect,
  dayProgress,
  layoutCampus,
  minutesOf,
  roomFront,
  roomStatus,
  sessionProgress,
} from "@/domain/center-3d";
import { timeNow } from "@/lib/format";

const room = (id: string, capacity: number) => ({ id, name: `Phòng ${id}`, capacity });
const edges = (rect: Rect) => ({
  minX: rect.x - rect.width / 2,
  maxX: rect.x + rect.width / 2,
  minZ: rect.z - rect.depth / 2,
  maxZ: rect.z + rect.depth / 2,
});
/** Hai hình chữ nhật có phần chung (chạm mép không tính). */
const overlap = (a: Rect, b: Rect) => {
  const [p, q] = [edges(a), edges(b)];
  return p.minX < q.maxX - 1e-9 && q.minX < p.maxX - 1e-9 && p.minZ < q.maxZ - 1e-9 && q.minZ < p.maxZ - 1e-9;
};
const inside = (inner: Rect, outer: Rect) => {
  const [p, q] = [edges(inner), edges(outer)];
  return p.minX >= q.minX - 1e-9 && p.maxX <= q.maxX + 1e-9 && p.minZ >= q.minZ - 1e-9 && p.maxZ <= q.maxZ + 1e-9;
};

describe("dashboard 3D: bố trí khuôn viên", () => {
  it("bề ngang mặt tiền phòng theo sức chứa, trong giới hạn", () => {
    expect(roomFront(1)).toBe(6);
    expect(roomFront(10)).toBe(7);
    expect(roomFront(100)).toBe(9);
    expect(roomFront(8)).toBeLessThan(roomFront(16));
  });

  it("không có phòng: vẫn có tòa nhà chính, sân và hai con đường, canh giữa quanh gốc tọa độ", () => {
    const campus = layoutCampus([]);
    expect(campus.rooms).toEqual([]);
    expect(campus.bounds.x).toBeCloseTo(0);
    expect(campus.bounds.z).toBeCloseTo(0);
    expect(campus.main).toMatchObject({ width: MAIN_WIDTH, depth: MAIN_DEPTH });
    expect(campus.plaza.width).toBeGreaterThanOrEqual(14);
    expect(campus.plaza.depth).toBeGreaterThanOrEqual(14);
    for (const part of [campus.main, campus.plaza, campus.roads.south, campus.roads.east]) expect(inside(part, campus.bounds)).toBe(true);
  });

  it.each([1, 2, 3, 5, 8, 12])("%i phòng: xếp lần lượt dãy bắc rồi dãy tây, cửa nhìn ra sân, không chồng nhau, nằm trong nền", (count) => {
    const rooms = Array.from({ length: count }, (_, index) => room(String(index), 6 + index * 3));
    const campus = layoutCampus(rooms);
    expect(campus.rooms.map((r) => r.id)).toEqual(rooms.map((r) => r.id));
    // Thứ tự danh sách: phòng chẵn vào dãy bắc (cửa quay về nam), phòng lẻ vào dãy tây (cửa quay về đông).
    expect(campus.rooms.map((r) => r.facing)).toEqual(rooms.map((_, index) => (index % 2 === 0 ? "south" : "east")));
    // Cùng dữ liệu luôn cho cùng kết quả.
    expect(layoutCampus(rooms)).toEqual(campus);

    const main = edges(campus.main);
    const plaza = edges(campus.plaza);
    for (const [index, placed] of campus.rooms.entries()) {
      const box = edges(placed);
      expect(placed.front).toBe(roomFront(rooms[index]!.capacity));
      if (placed.facing === "south") {
        // Mặt tiền thẳng hàng với mặt tiền tòa nhà chính, cách sân đúng một lối đi.
        expect(placed).toMatchObject({ width: placed.front, depth: ROOM_DEPTH });
        expect(box.maxZ).toBeCloseTo(main.maxZ);
        expect(plaza.minZ - box.maxZ).toBeCloseTo(APRON);
        expect(box.minX).toBeGreaterThanOrEqual(main.maxX + BUILDING_GAP - 1e-9);
      } else {
        expect(placed).toMatchObject({ width: ROOM_DEPTH, depth: placed.front });
        expect(box.maxX).toBeCloseTo(main.maxX);
        expect(plaza.minX - box.maxX).toBeCloseTo(APRON);
        expect(box.minZ).toBeGreaterThanOrEqual(main.maxZ + BUILDING_GAP - 1e-9);
      }
      expect(inside(placed, campus.bounds)).toBe(true);
    }
    // Không tòa nhà nào chồng lên nhau, lên sân hay lên đường; hai con đường không chồng nhau.
    const buildings: Rect[] = [campus.main, ...campus.rooms];
    for (const [i, a] of buildings.entries()) {
      for (const b of buildings.slice(i + 1)) expect(overlap(a, b)).toBe(false);
      for (const open of [campus.plaza, campus.roads.south, campus.roads.east]) expect(overlap(a, open)).toBe(false);
    }
    expect(overlap(campus.roads.south, campus.roads.east)).toBe(false);
    expect(overlap(campus.plaza, campus.roads.south)).toBe(false);
    expect(overlap(campus.plaza, campus.roads.east)).toBe(false);
    for (const part of [campus.main, campus.plaza, campus.roads.south, campus.roads.east]) expect(inside(part, campus.bounds)).toBe(true);
    expect(campus.bounds.x).toBeCloseTo(0);
    expect(campus.bounds.z).toBeCloseTo(0);
  });
});

describe("dashboard 3D: trạng thái phòng và tiến trình buổi học theo giờ", () => {
  const session = (id: string, startTime: string, endTime: string, extra: Partial<CenterSession> = {}): CenterSession => ({
    id,
    roomId: "r",
    className: `Lớp ${id}`,
    teacherName: "GV",
    startTime,
    endTime,
    cancelled: false,
    timetableOnly: false,
    studentCount: 4,
    href: null,
    ...extra,
  });
  const day = [session("chieu", "14:00", "15:30"), session("sang", "08:00", "09:30"), session("toi", "18:00", "19:30")];
  const at = (now: string, sessions = day) => {
    const { state, session: shown } = roomStatus(sessions, now);
    return `${state}:${shown?.id ?? "-"}`;
  };

  it("đang học khi bắt đầu ≤ giờ hiện tại < kết thúc; còn lại là sắp học buổi kế tiếp, hoặc đã học xong", () => {
    expect(at("07:59")).toBe("upcoming:sang");
    expect(at("08:00")).toBe("live:sang");
    expect(at("09:29")).toBe("live:sang");
    expect(at("09:30")).toBe("upcoming:chieu");
    expect(at("15:00")).toBe("live:chieu");
    expect(at("17:59")).toBe("upcoming:toi");
    expect(at("19:30")).toBe("done:toi");
    expect(at("23:59")).toBe("done:toi");
  });

  it("phòng không có buổi thì trống; buổi đã hủy không tính", () => {
    expect(at("10:00", [])).toBe("idle:-");
    const cancelled = [session("huy", "08:00", "09:30", { cancelled: true })];
    expect(at("08:30", cancelled)).toBe("idle:-");
    expect(at("08:30", [...cancelled, session("sau", "10:00", "11:30")])).toBe("upcoming:sau");
  });

  it("tiến trình của một buổi: phần thời gian đã trôi qua, từ 0 đến 1", () => {
    const morning = day[1]!;
    expect(minutesOf("08:30")).toBe(510);
    expect(sessionProgress(morning, "07:00")).toBe(0);
    expect(sessionProgress(morning, "08:00")).toBe(0);
    expect(sessionProgress(morning, "08:45")).toBeCloseTo(0.5);
    expect(sessionProgress(morning, "09:30")).toBe(1);
    expect(sessionProgress(morning, "20:00")).toBe(1);
  });

  it("tiến trình của ngày: buổi xong tính trọn, buổi đang học tính theo thời gian, buổi hủy đếm riêng", () => {
    const sessions = [...day, session("huy", "10:00", "11:00", { cancelled: true })];
    expect(dayProgress([], "10:00")).toEqual({ total: 0, done: 0, live: 0, upcoming: 0, cancelled: 0, percent: 0 });
    expect(dayProgress(sessions, "07:00")).toEqual({ total: 3, done: 0, live: 0, upcoming: 3, cancelled: 1, percent: 0 });
    // 08:45: buổi sáng được một nửa → 0,5/3 ≈ 17%.
    expect(dayProgress(sessions, "08:45")).toEqual({ total: 3, done: 0, live: 1, upcoming: 2, cancelled: 1, percent: 17 });
    expect(dayProgress(sessions, "12:00")).toEqual({ total: 3, done: 1, live: 0, upcoming: 2, cancelled: 1, percent: 33 });
    expect(dayProgress(sessions, "23:00")).toEqual({ total: 3, done: 3, live: 0, upcoming: 0, cancelled: 1, percent: 100 });
  });

  it("giờ hiện tại theo giờ Việt Nam, dạng HH:MM 24 giờ", () => {
    expect(timeNow(new Date("2026-01-21T05:07:00Z"))).toBe("12:07");
    expect(timeNow(new Date("2026-01-21T17:00:00Z"))).toBe("00:00");
    expect(timeNow(new Date("2026-01-21T16:59:00Z"))).toBe("23:59");
  });
});
