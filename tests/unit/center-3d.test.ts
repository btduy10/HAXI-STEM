import { describe, expect, it } from "vitest";
import {
  CORRIDOR_WIDTH,
  type CenterSession,
  MAX_SEATS,
  ROOM_GAP,
  layoutRooms,
  roomStatus,
  roomWidth,
  seatPositions,
} from "@/domain/center-3d";
import { timeNow } from "@/lib/format";

const room = (id: string, capacity: number) => ({ id, name: `Phòng ${id}`, capacity });

describe("giao diện 3D trung tâm: bố trí phòng", () => {
  it("bề ngang phòng theo sức chứa, trong giới hạn", () => {
    expect(roomWidth(1)).toBe(5);
    expect(roomWidth(12)).toBe(7);
    expect(roomWidth(100)).toBe(9);
    expect(roomWidth(8)).toBeLessThan(roomWidth(16));
  });

  it("không có phòng thì cảnh rỗng", () => {
    expect(layoutRooms([])).toEqual({ rooms: [], length: 0 });
  });

  it("xếp hai dãy dọc hành lang theo thứ tự danh sách, phòng kế tiếp vào dãy đang ngắn hơn, canh giữa", () => {
    const rooms = [room("a", 12), room("b", 6), room("c", 6), room("d", 20), room("e", 8)];
    const { rooms: placed, length } = layoutRooms(rooms);
    expect(placed.map((p) => p.id)).toEqual(["a", "b", "c", "d", "e"]);
    // a (7 m) dãy sau; b (5,5 m) dãy trước; c vào dãy trước (ngắn hơn); d vào dãy sau; e vào dãy trước.
    expect(placed.map((p) => p.side)).toEqual([-1, 1, 1, -1, 1]);
    // Cùng dữ liệu luôn cho cùng kết quả.
    expect(layoutRooms(rooms)).toEqual({ rooms: placed, length });

    for (const side of [-1, 1] as const) {
      const row = placed.filter((p) => p.side === side).sort((x, y) => x.x - y.x);
      for (const p of row) {
        // Phòng nằm hẳn một bên hành lang, cửa sát mép hành lang.
        expect(Math.abs(p.z) - p.depth / 2).toBeCloseTo(CORRIDOR_WIDTH / 2);
        expect(Math.sign(p.z)).toBe(side);
      }
      // Hai phòng kề nhau trong một dãy cách nhau đúng một khe, không chồng lên nhau.
      for (let i = 1; i < row.length; i++) {
        const [left, right] = [row[i - 1]!, row[i]!];
        expect(right.x - right.width / 2 - (left.x + left.width / 2)).toBeCloseTo(ROOM_GAP);
      }
    }
    // Canh giữa: dãy dài nhất trải từ -length/2 đến length/2.
    const edges = placed.flatMap((p) => [p.x - p.width / 2, p.x + p.width / 2]);
    expect(Math.min(...edges)).toBeCloseTo(-length / 2);
    expect(Math.max(...edges)).toBeCloseTo(length / 2);
  });

  it("chỗ ngồi nằm trong phòng, chừa khoảng trước bảng, tối đa số chỗ được vẽ", () => {
    expect(seatPositions(6, 6, 0)).toEqual([]);
    expect(seatPositions(5, 6, 1)).toHaveLength(1);
    for (const [width, capacity] of [[5, 4], [7, 12], [9, 20], [9, 60]] as const) {
      const seats = seatPositions(width, 6, capacity);
      expect(seats).toHaveLength(Math.min(capacity, MAX_SEATS));
      for (const seat of seats) {
        expect(Math.abs(seat.x)).toBeLessThanOrEqual(width / 2 - 0.5);
        expect(seat.z).toBeGreaterThanOrEqual(-3 + 0.5);
        expect(seat.z).toBeLessThanOrEqual(3 - 1.7);
      }
      // Không có hai chỗ trùng nhau.
      expect(new Set(seats.map((seat) => `${seat.x.toFixed(3)}|${seat.z.toFixed(3)}`)).size).toBe(seats.length);
    }
  });
});

describe("giao diện 3D trung tâm: trạng thái phòng theo giờ", () => {
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

  it("giờ hiện tại theo giờ Việt Nam, dạng HH:MM 24 giờ", () => {
    expect(timeNow(new Date("2026-01-21T05:07:00Z"))).toBe("12:07");
    expect(timeNow(new Date("2026-01-21T17:00:00Z"))).toBe("00:00");
    expect(timeNow(new Date("2026-01-21T16:59:00Z"))).toBe("23:59");
  });
});
