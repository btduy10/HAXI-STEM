import { z } from "zod";
import { ROLE_KEY } from "@/lib/permissions";
import {
  code,
  id,
  intIn,
  isoDate,
  optEmail,
  optId,
  optIntIn,
  optIsoDate,
  optPhone,
  optText,
  reqText,
  timeOfDay,
} from "./common";

/** Ca học cố định: Admin chọn, không nhập tên. */
export const SLOT_NAMES = ["Ca sáng", "Ca chiều", "Ca tối"] as const;
export const SLOT_NAME_LABELS: Record<(typeof SLOT_NAMES)[number], string> = { "Ca sáng": "Sáng", "Ca chiều": "Chiều", "Ca tối": "Tối" };
/** Số khung giờ tối đa của một ca (Khung 1 … Khung 10). */
export const MAX_SLOT_FRAMES = 10;

// Mã lớp, mã giáo viên là văn bản tự do (vd. "RB - S7"), chỉ gộp khoảng trắng thừa; không ép chữ hoa hay bộ ký tự.
const freeCode = reqText(30).transform((v) => v.replace(/\s+/g, " "));

export const teacherInput = z.object({
  code: freeCode,
  fullName: reqText(100),
  /** Tên viết tắt hiển thị trên Thời khóa biểu; để trống thì dùng họ tên. */
  shortName: optText(20),
  phone: optPhone,
  email: optEmail,
  status: z.enum(["active", "inactive"]).default("active"),
});

export const studentInput = z.object({
  code,
  fullName: reqText(100),
  birthDate: optIsoDate,
  gender: z
    .union([z.enum(["male", "female", "other"]), z.literal("")])
    .nullish()
    .transform((v) => (v ? v : null)),
  schoolGrade: optIntIn(1, 12),
  guardianName: optText(100),
  phone: optPhone,
  status: z.enum(["active", "paused", "left"]).default("active"),
  note: optText(500),
});

/**
 * Học viên mới nhập ở trang Ghi danh: thông tin học viên kèm lớp muốn vào. Form không có ô mã: máy chủ luôn tự cấp
 * mã kế tiếp (HX + năm + số thứ tự), mã gửi kèm bị bỏ qua.
 * `classId` trống hoặc "none" = chưa xếp lớp (em vào danh sách chờ lớp).
 */
export const newEnrollmentInput = studentInput
  .omit({ code: true })
  .extend({
    classId: z
      .union([id, z.literal(""), z.literal("none")])
      .nullish()
      .transform((v) => (v && v !== "none" ? v : null)),
    joinedAt: optIsoDate,
  })
  .refine((v) => !v.classId || v.joinedAt, { path: ["joinedAt"], message: "Bắt buộc nhập" });

export const courseInput = z.object({
  name: reqText(100),
  description: optText(500),
  totalSessions: intIn(1, 500),
});

export const roomInput = z.object({
  name: reqText(50),
  capacity: intIn(1, 500),
});

export const timeSlotInput = z
  .object({
    name: z.enum(SLOT_NAMES, { error: "Chọn Sáng, Chiều hoặc Tối" }),
    frame: intIn(1, MAX_SLOT_FRAMES),
    defaultStart: timeOfDay,
    defaultEnd: timeOfDay,
  })
  .refine((v) => v.defaultStart < v.defaultEnd, { path: ["defaultEnd"], message: "Giờ kết thúc phải sau giờ bắt đầu" });

/** Sửa một bài trong Syllabus: buổi, tên bài/chủ đề, sản phẩm (lớp của bài không đổi). */
export const syllabusEdit = z.object({
  period: intIn(1, 999),
  title: reqText(200),
  product: optText(200),
});
/** Thêm một bài vào Syllabus: chọn lớp (menu Lớp học) và khóa học (menu Khóa học). */
export const syllabusInput = syllabusEdit.extend({ classId: id, courseId: id });

export const TIMESHEET_ROLES = ["main", "substitute", "assistant"] as const;
/** Công bổ sung: dòng công ghi tay của giáo viên ở bảng Chấm công. */
export const timesheetEntryInput = z.object({
  teacherId: id,
  date: isoDate,
  timeSlotId: id,
  classId: id,
  role: z.enum(TIMESHEET_ROLES, { error: "Chọn vai trò" }).default("main"),
  note: optText(300),
});
export const timesheetEntryUpdate = timesheetEntryInput.extend({ id });
/** Sửa dòng công sinh từ buổi học (chỉ đổi trên bảng công). `timeSlotId` trống = giữ giờ của buổi. */
export const timesheetAdjustInput = z.object({
  sessionId: id,
  part: z.enum(["lead", "assistant"]),
  date: isoDate,
  timeSlotId: optId,
  classId: id,
  note: optText(300),
});

/** Một khoản mua sắm của trung tâm. Thành tiền = số lượng × đơn giá. */
export const purchaseInput = z.object({
  purchasedAt: isoDate,
  item: reqText(200),
  category: reqText(60).transform((v) => v.replace(/\s+/g, " ")),
  quantity: intIn(1, 100_000),
  unitPrice: intIn(0, 1_000_000_000),
});

export const holidayInput = z.object({
  date: isoDate,
  reason: reqText(200),
  classId: optId,
});

/** Lớp học: mã lớp do máy chủ tự cấp (RB + năm + số thứ tự) nên không có trong form; lớp không gắn với khóa học. */
export const classInput = z
  .object({
    name: reqText(100),
    defaultRoomId: optId,
    startDate: isoDate,
    endDate: isoDate,
    maxSize: intIn(1, 200),
    /** true = lớp chỉ hiển thị trên Thời khóa biểu (vd. cho mượn phòng). Form gửi "true"/"false". */
    timetableOnly: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .default(false)
      .transform((v) => v === true || v === "true"),
  })
  .refine((v) => v.startDate <= v.endDate, { path: ["endDate"], message: "Ngày kết thúc phải sau ngày bắt đầu" });

/** Mức lương mỗi buổi (đồng) của một giáo viên/trợ giảng ở một lớp. */
export const teacherRateInput = z.object({
  teacherId: id,
  classId: id,
  rate: intIn(0, 100_000_000),
});

export const enrollInput = z.object({
  classId: id,
  studentId: id,
  joinedAt: isoDate,
});

/** Xếp một buổi vắng của học viên vào học bù ở một buổi có sẵn. */
export const makeupAssignInput = z.object({ absentSessionId: id, studentId: id, makeupSessionId: id });

export const leaveInput = z.object({
  id,
  leftAt: isoDate,
});

export const password = z
  .string({ error: "Bắt buộc nhập" })
  .min(8, "Mật khẩu tối thiểu 8 ký tự")
  .max(128, "Mật khẩu tối đa 128 ký tự")
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), "Mật khẩu phải có cả chữ và số");

export const accountInput = z
  .object({
    username: z
      .string({ error: "Bắt buộc nhập" })
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9._-]{3,32}$/, "3–32 ký tự: chữ thường, số, dấu . _ -"),
    name: reqText(100),
    role: z.string({ error: "Bắt buộc chọn" }).regex(ROLE_KEY, "Vai trò không hợp lệ"),
    teacherId: optId,
    password,
  })
  .refine((v) => v.role !== "teacher" || v.teacherId, {
    path: ["teacherId"],
    message: "Tài khoản giáo viên phải gắn với một giáo viên",
  });

/** Sửa tài khoản: không đổi mật khẩu ở đây (dùng "Đặt lại mật khẩu"). */
export const accountEditInput = z
  .object({
    id: z.string().min(1).max(64),
    username: z
      .string({ error: "Bắt buộc nhập" })
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9._-]{3,32}$/, "3–32 ký tự: chữ thường, số, dấu . _ -"),
    name: reqText(100),
    role: z.string({ error: "Bắt buộc chọn" }).regex(ROLE_KEY, "Vai trò không hợp lệ"),
    teacherId: optId,
  })
  .refine((v) => v.role !== "teacher" || v.teacherId, {
    path: ["teacherId"],
    message: "Tài khoản giáo viên phải gắn với một giáo viên",
  });
export const resetPasswordInput = z.object({
  id: z.string().min(1).max(64),
  password,
  /** true = mật khẩu tạm, người dùng phải đổi ở lần đăng nhập sau; false = dùng luôn mật khẩu này. */
  mustChange: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .default(true)
    .transform((v) => v === true || v === "true"),
});
/** Gửi tài khoản qua email: mật khẩu tạm do Admin nhập, luôn bắt đổi ở lần đăng nhập đầu. */
export const sendCredentialsInput = z.object({ id: z.string().min(1).max(64), password });
export const userIdInput = z.object({ id: z.string().min(1).max(64) });
export const lockInput = z.object({ id: z.string().min(1).max(64), locked: z.boolean() });

const withId = <T extends z.ZodType>(schema: T) => z.object({ id, data: schema });
export const teacherUpdate = withId(teacherInput);
export const studentUpdate = withId(studentInput);
export const courseUpdate = withId(courseInput);
export const roomUpdate = withId(roomInput);
export const timeSlotUpdate = withId(timeSlotInput);
export const syllabusUpdate = withId(syllabusEdit);
export const classUpdate = withId(classInput);
export const teacherRateUpdate = withId(teacherRateInput);
export const purchaseUpdate = withId(purchaseInput);
