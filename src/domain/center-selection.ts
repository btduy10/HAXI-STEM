import { type CenterSession, roomStatus } from "./center-3d";

/** Giáo viên hoặc học viên đang mở ở thẻ chi tiết. */
export type Person = { kind: "teacher" | "student"; id: string; name: string };

/** Đối tượng đang chọn trên trang Tổng quan: phòng, buổi học và người (nếu có). */
export type Selection = { roomId: string | null; sessionId: string | null; person: Person | null };

export const NO_SELECTION: Selection = { roomId: null, sessionId: null, person: null };

export type SelectAction =
  /** Chọn một phòng (null: bỏ chọn): chọn luôn buổi đang ghi trên nhãn của phòng. */
  | { type: "room"; roomId: string | null }
  /** Chọn một buổi học (ở danh sách hoặc tìm kiếm). */
  | { type: "session"; sessionId: string }
  | { type: "teacher"; id: string; name: string }
  /** Chọn học viên; `viaSessionId`: buổi để bay tới, bỏ trống thì giữ buổi đang chọn. */
  | { type: "student"; id: string; name: string; viaSessionId?: string }
  /** Bấm một hình người trước cửa phòng trong cảnh 3D: giáo viên, hoặc học viên thứ `index` của buổi. */
  | { type: "figure"; roomId: string; kind: Person["kind"]; index: number }
  /** Đóng thẻ của người đang mở, giữ phòng và buổi. */
  | { type: "close-person" };

/** Dữ liệu hôm nay mà việc chọn cần biết. */
export type SelectContext = {
  sessions: CenterSession[];
  /** Mã các phòng có trên mặt bằng; buổi ở phòng không có trong đây coi như chưa xếp phòng. */
  roomIds: { has(roomId: string): boolean };
  /** Giờ Việt Nam "HH:MM". */
  now: string;
  /** Người dùng được mở thẻ học viên (bấm hình học viên thì mở học viên đó; không thì mở lớp). */
  students: boolean;
  /** Danh sách học viên đã tải của một buổi, để biết hình học viên thứ i là ai. */
  roster: { sessionId: string; students: { studentId: string; fullName: string }[] } | null;
};

/** Lựa chọn mới, và phòng để máy quay bay tới: undefined = không bay; null = bay về toàn cảnh (buổi chưa xếp phòng). */
export type SelectResult = { selection: Selection; flyTo: string | null | undefined };

const roomOf = (context: SelectContext, session: CenterSession) => (session.roomId && context.roomIds.has(session.roomId) ? session.roomId : null);

/** Buổi đang ghi trên nhãn của một phòng: đang học, sắp học, hoặc buổi cuối đã xong. */
export const roomSession = (context: SelectContext, roomId: string) =>
  roomStatus(
    context.sessions.filter((item) => item.roomId === roomId),
    context.now,
  ).session;

function focus(person: Person | null, session: CenterSession, context: SelectContext): SelectResult {
  const roomId = roomOf(context, session);
  return { selection: { roomId, sessionId: session.id, person }, flyTo: roomId };
}

/**
 * Luật chọn đối tượng của trang Tổng quan: từ lựa chọn hiện tại và một thao tác, tính lựa chọn mới và chỗ máy quay bay tới.
 * Buổi hay phòng đã chọn mà không còn trong dữ liệu hôm nay (sau khi làm mới) coi như chưa chọn.
 */
export function select(current: Selection, action: SelectAction, context: SelectContext): SelectResult {
  const find = (id: string | null | undefined) => (id ? context.sessions.find((item) => item.id === id) : undefined);
  const unchanged = (selection: Selection): SelectResult => ({ selection, flyTo: undefined });

  switch (action.type) {
    case "room": {
      if (!action.roomId) return unchanged({ roomId: null, sessionId: null, person: null });
      return {
        selection: { roomId: action.roomId, sessionId: roomSession(context, action.roomId)?.id ?? null, person: null },
        flyTo: action.roomId,
      };
    }
    case "session": {
      const target = find(action.sessionId);
      return target ? focus(null, target, context) : unchanged(current);
    }
    case "teacher": {
      const person: Person = { kind: "teacher", id: action.id, name: action.name };
      // Giữ buổi đang chọn nếu chính giáo viên này dạy; không thì tới buổi giáo viên đang dạy (hoặc buổi kế tiếp, hoặc buổi cuối hôm nay).
      const selected = find(current.sessionId);
      const target =
        selected?.teacherId === action.id
          ? selected
          : roomStatus(
              context.sessions.filter((item) => item.teacherId === action.id),
              context.now,
            ).session;
      return target ? focus(person, target, context) : unchanged({ ...current, person });
    }
    case "student": {
      const person: Person = { kind: "student", id: action.id, name: action.name };
      const target = action.viaSessionId ? find(action.viaSessionId) : find(current.sessionId);
      return target ? focus(person, target, context) : unchanged({ ...current, person });
    }
    case "figure": {
      const target = roomSession(context, action.roomId);
      if (!target) return unchanged(current);
      if (action.kind === "teacher") {
        return target.teacherId && target.teacherName ? select(current, { type: "teacher", id: target.teacherId, name: target.teacherName }, context) : unchanged(current);
      }
      // Hình học viên thứ i ứng với học viên thứ i của danh sách, khi danh sách của buổi đó đã tải; chưa thì mở lớp trước.
      const student = context.students && context.roster?.sessionId === target.id ? context.roster.students[action.index] : undefined;
      return student
        ? select(current, { type: "student", id: student.studentId, name: student.fullName, viaSessionId: target.id }, context)
        : select(current, { type: "session", sessionId: target.id }, context);
    }
    case "close-person":
      return unchanged({ ...current, person: null });
  }
}

/** Hình người cần đánh dấu trong cảnh: giáo viên của buổi đang chọn, hoặc học viên theo thứ tự trong danh sách của buổi. */
export function selectedFigure(
  selection: Selection,
  context: SelectContext,
): { roomId: string; kind: Person["kind"]; index: number; label: string } | null {
  const { person, roomId, sessionId } = selection;
  if (!person || !roomId || !sessionId || !context.roomIds.has(roomId) || roomSession(context, roomId)?.id !== sessionId) return null;
  if (person.kind === "teacher") {
    const session = context.sessions.find((item) => item.id === sessionId);
    return session?.teacherId === person.id ? { roomId, kind: "teacher", index: 0, label: person.name } : null;
  }
  const index = context.roster?.sessionId === sessionId ? context.roster.students.findIndex((item) => item.studentId === person.id) : -1;
  return index >= 0 ? { roomId, kind: "student", index, label: person.name } : null;
}
