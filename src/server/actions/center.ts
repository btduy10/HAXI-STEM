"use server";

import { centerSearchInput, centerSessionInput, centerStudentInput, centerTeacherInput } from "@/lib/validation/center";
import { runAction } from "../action";
import * as center from "../services/center-detail";

// Các hàm ĐỌC của dashboard 3D (trang Tổng quan): chi tiết chỉ tải khi người dùng mở một buổi, một học viên hay một giáo viên.
// Đi qua runAction như mọi action khác (phiên ở máy chủ, giới hạn tốc độ, Zod); service tự kiểm tra quyền và phạm vi lớp.
// Không làm mới trang vì không ghi gì.

export const centerSessionAction = async (input: unknown) => runAction(centerSessionInput, input, (a, d) => center.sessionDetail(a, d.sessionId));
export const centerStudentAction = async (input: unknown) => runAction(centerStudentInput, input, (a, d) => center.studentDetail(a, d.studentId));
export const centerTeacherAction = async (input: unknown) => runAction(centerTeacherInput, input, (a, d) => center.teacherWeek(a, d.teacherId));
export const centerSearchAction = async (input: unknown) => runAction(centerSearchInput, input, (a, d) => center.searchStudents(a, d.query));
export const centerWorkspaceAction = async (input: unknown) => runAction(centerSessionInput, input, (a, d) => center.sessionWorkspace(a, d.sessionId));
