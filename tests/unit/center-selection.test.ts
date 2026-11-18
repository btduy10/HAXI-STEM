import { describe, expect, it } from "vitest";
import type { CenterSession } from "@/domain/center-3d";
import { NO_SELECTION, type SelectContext, type Selection, select, selectedFigure } from "@/domain/center-selection";

const session = (id: string, roomId: string | null, teacherId: string | null, startTime: string, endTime: string): CenterSession => ({
  id,
  classId: `lop-${id}`,
  roomId,
  className: `Lớp ${id}`,
  teacherId,
  teacherName: teacherId ? `GV ${teacherId}` : null,
  startTime,
  endTime,
  cancelled: false,
  timetableOnly: false,
  studentCount: 2,
  attendanceCount: 0,
  starLogCount: 0,
  href: null,
});

// Phòng A: buổi sáng đã xong (GV lan) và buổi đang học (GV minh). Phòng B: buổi chiều (GV lan). Buổi tối chưa xếp phòng (GV lan).
// "x" ở phòng đã bị xóa khỏi mặt bằng nên coi như chưa xếp phòng.
const sessions = [
  session("sang", "A", "lan", "08:00", "09:30"),
  session("dang-hoc", "A", "minh", "10:00", "11:30"),
  session("chieu", "B", "lan", "14:00", "15:30"),
  session("toi", null, "lan", "18:00", "19:30"),
  session("x", "phong-cu", "minh", "16:00", "17:00"),
];
const roster = { sessionId: "dang-hoc", students: [{ studentId: "hv1", fullName: "An" }, { studentId: "hv2", fullName: "Bình" }] };
const context: SelectContext = { sessions, roomIds: new Set(["A", "B"]), now: "10:15", students: true, roster };
const run = (current: Selection, ...actions: Parameters<typeof select>[1][]) => {
  let state = { selection: current, flyTo: undefined as string | null | undefined };
  for (const action of actions) state = select(state.selection, action, context);
  return state;
};

describe("chọn đối tượng trên trang Tổng quan", () => {
  it("chọn phòng: chọn luôn buổi trên nhãn phòng (đang học trước), bay tới phòng; bỏ chọn thì xóa hết, không bay", () => {
    expect(run(NO_SELECTION, { type: "room", roomId: "A" })).toEqual({ selection: { roomId: "A", sessionId: "dang-hoc", person: null }, flyTo: "A" });
    expect(run(NO_SELECTION, { type: "room", roomId: "B" }).selection.sessionId).toBe("chieu");
    expect(run({ roomId: "A", sessionId: "dang-hoc", person: { kind: "teacher", id: "minh", name: "GV minh" } }, { type: "room", roomId: null })).toEqual({
      selection: NO_SELECTION,
      flyTo: undefined,
    });
  });

  it("chọn buổi: phòng theo buổi; buổi chưa xếp phòng hoặc ở phòng không còn trên mặt bằng thì bay về toàn cảnh; buổi không còn thì giữ nguyên", () => {
    expect(run(NO_SELECTION, { type: "session", sessionId: "sang" })).toEqual({ selection: { roomId: "A", sessionId: "sang", person: null }, flyTo: "A" });
    expect(run(NO_SELECTION, { type: "session", sessionId: "toi" })).toEqual({ selection: { roomId: null, sessionId: "toi", person: null }, flyTo: null });
    expect(run(NO_SELECTION, { type: "session", sessionId: "x" }).flyTo).toBeNull();
    const current: Selection = { roomId: "B", sessionId: "chieu", person: null };
    expect(run(current, { type: "session", sessionId: "khong-co" })).toEqual({ selection: current, flyTo: undefined });
  });

  it("chọn giáo viên: giữ buổi đang chọn nếu chính GV đó dạy, không thì tới buổi GV đang dạy / sắp dạy / buổi cuối", () => {
    const lan = { kind: "teacher" as const, id: "lan", name: "GV lan" };
    // Đang mở buổi chiều của lan: chọn lan không đổi buổi (lỗi cũ: nhảy sang buổi khác của GV).
    expect(run({ roomId: "B", sessionId: "chieu", person: null }, { type: "teacher", ...lan }).selection).toEqual({ roomId: "B", sessionId: "chieu", person: lan });
    // Từ buổi của minh: lan chưa dạy lúc 10:15 nên tới buổi sắp dạy (chiều).
    expect(run({ roomId: "A", sessionId: "dang-hoc", person: null }, { type: "teacher", ...lan }).selection.sessionId).toBe("chieu");
    // GV không có buổi nào hôm nay: chỉ mở thẻ GV, giữ phòng và buổi.
    expect(run({ roomId: "A", sessionId: "sang", person: null }, { type: "teacher", id: "khac", name: "GV khác" })).toEqual({
      selection: { roomId: "A", sessionId: "sang", person: { kind: "teacher", id: "khac", name: "GV khác" } },
      flyTo: undefined,
    });
  });

  it("chọn học viên: tới buổi được chỉ định, hoặc giữ buổi đang chọn; đóng thẻ người thì giữ phòng và buổi", () => {
    const an = { kind: "student" as const, id: "hv1", name: "An" };
    expect(run(NO_SELECTION, { type: "student", id: "hv1", name: "An", viaSessionId: "toi" })).toEqual({ selection: { roomId: null, sessionId: "toi", person: an }, flyTo: null });
    expect(run({ roomId: "A", sessionId: "dang-hoc", person: null }, { type: "student", id: "hv1", name: "An" })).toEqual({
      selection: { roomId: "A", sessionId: "dang-hoc", person: an },
      flyTo: "A",
    });
    expect(run(NO_SELECTION, { type: "student", id: "hv1", name: "An" }).selection).toEqual({ ...NO_SELECTION, person: an });
    expect(run({ roomId: "A", sessionId: "dang-hoc", person: an }, { type: "close-person" }).selection).toEqual({ roomId: "A", sessionId: "dang-hoc", person: null });
  });

  it("bấm hình người trong cảnh: GV của buổi trên nhãn phòng; học viên thứ i khi đã tải danh sách, chưa tải hoặc không có quyền thì mở lớp", () => {
    expect(run(NO_SELECTION, { type: "figure", roomId: "A", kind: "teacher", index: 0 }).selection).toEqual({
      roomId: "A",
      sessionId: "dang-hoc",
      person: { kind: "teacher", id: "minh", name: "GV minh" },
    });
    expect(run(NO_SELECTION, { type: "figure", roomId: "A", kind: "student", index: 1 }).selection.person).toEqual({ kind: "student", id: "hv2", name: "Bình" });
    // Phòng B: danh sách đã tải là của buổi khác → mở lớp.
    expect(run(NO_SELECTION, { type: "figure", roomId: "B", kind: "student", index: 0 }).selection).toEqual({ roomId: "B", sessionId: "chieu", person: null });
    expect(select(NO_SELECTION, { type: "figure", roomId: "A", kind: "student", index: 0 }, { ...context, students: false }).selection.person).toBeNull();
  });

  it("hình người được đánh dấu: chỉ khi buổi đang chọn đúng là buổi trên nhãn phòng", () => {
    expect(selectedFigure({ roomId: "A", sessionId: "dang-hoc", person: { kind: "teacher", id: "minh", name: "GV minh" } }, context)).toEqual({
      roomId: "A",
      kind: "teacher",
      index: 0,
      label: "GV minh",
    });
    expect(selectedFigure({ roomId: "A", sessionId: "dang-hoc", person: { kind: "student", id: "hv2", name: "Bình" } }, context)).toMatchObject({ kind: "student", index: 1 });
    // Buổi sáng đã xong không phải buổi trên nhãn phòng A lúc 10:15: không có hình nào để đánh dấu.
    expect(selectedFigure({ roomId: "A", sessionId: "sang", person: { kind: "teacher", id: "lan", name: "GV lan" } }, context)).toBeNull();
    expect(selectedFigure({ roomId: "A", sessionId: "dang-hoc", person: { kind: "teacher", id: "lan", name: "GV lan" } }, context)).toBeNull();
    expect(selectedFigure({ roomId: "phong-cu", sessionId: "x", person: { kind: "teacher", id: "minh", name: "GV minh" } }, context)).toBeNull();
  });
});
