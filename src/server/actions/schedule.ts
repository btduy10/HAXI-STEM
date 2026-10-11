"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { idOnly } from "@/lib/validation/common";
import {
  attendanceInput,
  makeupInput,
  manualSessionInput,
  sessionCancelInput,
  sessionEditInput,
  sessionIdInput,
  sessionRescheduleInput,
  sessionSubstituteInput,
  templateInput,
  templateUpdateInput,
} from "@/lib/validation/schedule";
import { runAction } from "../action";
import * as attendance from "../services/attendance";
import * as sessions from "../services/sessions";

const ADMIN = "/admin";
const noInput = z.object({});
const withClassId = (classId: unknown, input: unknown) => ({ ...(typeof input === "object" ? input : null), classId });

export const createTemplateAction = async (classId: unknown, input: unknown) =>
  runAction(templateInput, withClassId(classId, input), (a, d) => sessions.createTemplate(a, d), ADMIN);
/** Form sửa dùng chung gửi { id, data }. */
const flatten = (input: unknown) => {
  const value = (typeof input === "object" && input ? input : {}) as { id?: unknown; data?: unknown };
  return { ...(typeof value.data === "object" ? value.data : null), id: value.id };
};
export const updateTemplateAction = async (input: unknown) =>
  runAction(templateUpdateInput, flatten(input), (a, d) => sessions.updateTemplate(a, d), ADMIN);
export const deleteTemplateAction = async (input: unknown) =>
  runAction(idOnly, input, (a, d) => sessions.deleteTemplate(a, d.id), ADMIN);
/** Thời khóa biểu: bổ sung buổi tuần sau cho mọi lớp đang mở trong phạm vi của người bấm. */
export const generateNextWeekForAllAction = async () => runAction(noInput, {}, (a) => sessions.generateNextWeekForAll(a), ADMIN);

export const updateSessionAction = async (input: unknown) => runAction(sessionEditInput, input, sessions.updateSession, ADMIN);
export const rescheduleSessionAction = async (input: unknown) =>
  runAction(sessionRescheduleInput, input, sessions.rescheduleSession, ADMIN);
export const cancelSessionAction = async (input: unknown) => runAction(sessionCancelInput, input, sessions.cancelSession, ADMIN);
export const restoreSessionAction = async (input: unknown) =>
  runAction(idOnly, input, (a, d) => sessions.restoreSession(a, d.id), ADMIN);
/** Xóa buổi xếp sai rồi đưa Admin về thời khóa biểu của ngày đó (trang buổi học không còn tồn tại). */
export const deleteSessionAction = async (input: unknown) => {
  const result = await runAction(idOnly, input, (a, d) => sessions.deleteSession(a, d.id), ADMIN);
  if (result.ok) redirect(`/admin/timetable?date=${result.data.date}`);
  return result;
};
export const setSubstituteAction = async (input: unknown) =>
  runAction(sessionSubstituteInput, input, sessions.setSubstitute, ADMIN);
export const createManualSessionAction = async (input: unknown) =>
  runAction(manualSessionInput, input, sessions.createManualSession, ADMIN);
export const createMakeupAction = async (input: unknown) => runAction(makeupInput, input, sessions.createMakeupSession, ADMIN);

// Dùng chung cho Admin và GV: service kiểm tra quyền trên từng buổi.
export const saveAttendanceAction = async (input: unknown) =>
  runAction(attendanceInput, input, (a, d) => attendance.saveAttendance(a, d), "/");
export const unlockAttendanceAction = async (input: unknown) =>
  runAction(sessionIdInput, input, (a, d) => attendance.unlockAttendance(a, d.sessionId), ADMIN);
