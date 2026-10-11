import { z } from "zod";
import { id, intIn, isoDate, optId, optText, timeOfDay } from "./common";

const optTime = z
  .union([timeOfDay, z.literal("")])
  .nullish()
  .transform((v) => (v ? v : null));

const startBeforeEnd = { path: ["endTime"], message: "Giờ kết thúc phải sau giờ bắt đầu" };

const templateFields = {
  weekday: intIn(1, 7),
  timeSlotId: id,
  // Không có phòng: buổi của lớp luôn dùng phòng đã chọn khi tạo lớp.
  teacherId: optId,
  assistantTeacherId: optId,
  startTime: optTime,
  endTime: optTime,
};
const bothOrNeither = (v: { startTime: string | null; endTime: string | null }) => (v.startTime === null) === (v.endTime === null);
const bothOrNeitherMessage = { path: ["endTime"], message: "Nhập cả giờ bắt đầu và kết thúc, hoặc để trống cả hai" };

export const templateInput = z
  .object({ classId: id, ...templateFields })
  .refine(bothOrNeither, bothOrNeitherMessage)
  .refine((v) => !v.startTime || !v.endTime || v.startTime < v.endTime, startBeforeEnd);

/** Sửa một dòng lịch mẫu (không đổi lớp). */
export const templateUpdateInput = z
  .object({ id, ...templateFields })
  .refine(bothOrNeither, bothOrNeitherMessage)
  .refine((v) => !v.startTime || !v.endTime || v.startTime < v.endTime, startBeforeEnd);

/** Sửa riêng một buổi: giờ, phòng, GV, nội dung. */
export const sessionEditInput = z
  .object({
    id,
    startTime: timeOfDay,
    endTime: timeOfDay,
    roomId: optId,
    teacherId: optId,
    assistantTeacherId: optId,
    content: optText(500),
    note: optText(500),
  })
  .refine((v) => v.startTime < v.endTime, startBeforeEnd);

export const sessionRescheduleInput = z
  .object({ id, date: isoDate, startTime: timeOfDay, endTime: timeOfDay })
  .refine((v) => v.startTime < v.endTime, startBeforeEnd);

export const sessionCancelInput = z.object({ id, note: optText(500) });
export const sessionSubstituteInput = z.object({ id, substituteTeacherId: optId });

export const makeupInput = z
  .object({
    classId: id,
    date: isoDate,
    startTime: timeOfDay,
    endTime: timeOfDay,
    roomId: optId,
    teacherId: id,
    studentIds: z.array(id).min(1, "Chọn ít nhất một học viên").max(200),
    note: optText(500),
  })
  .refine((v) => v.startTime < v.endTime, startBeforeEnd);

export const ATTENDANCE_STATUSES = ["present", "late", "left_early", "excused", "absent"] as const;

export const attendanceInput = z.object({
  sessionId: id,
  content: optText(500),
  /** Nhận xét của giáo viên sau buổi dạy. Không gửi = giữ nguyên; gửi rỗng = xóa. */
  remark: optText(1000).optional(),
  entries: z
    .array(z.object({ studentId: id, status: z.enum(ATTENDANCE_STATUSES), note: optText(200) }))
    .min(1)
    .max(300),
});

export const sessionIdInput = z.object({ sessionId: id });

/** Admin xếp tay một buổi vào ô ngày × ca của thời khóa biểu. */
export const manualSessionInput = z.object({
  classId: id,
  date: isoDate,
  timeSlotId: id,
  teacherId: optId,
  roomId: optId,
});