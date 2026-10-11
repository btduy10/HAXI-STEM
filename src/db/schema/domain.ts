import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { teachers } from "./teachers";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const studentStatus = pgEnum("student_status", ["active", "paused", "left"]);
export const gender = pgEnum("gender", ["male", "female", "other"]);
export const classStatus = pgEnum("class_status", ["open", "closed"]);
export const classTeacherRole = pgEnum("class_teacher_role", ["main", "assistant"]);
export const enrollmentStatus = pgEnum("enrollment_status", ["active", "left"]);
export const sessionKind = pgEnum("session_kind", ["regular", "makeup"]);
export const sessionStatus = pgEnum("session_status", ["planned", "done", "cancelled"]);
export const attendanceStatus = pgEnum("attendance_status", ["present", "excused", "absent", "late", "left_early"]);
export const criteriaType = pgEnum("criteria_type", ["reward", "penalty"]);
export const avatarUnlockType = pgEnum("avatar_unlock_type", ["by_level", "gifted"]);
export const handoverStatus = pgEnum("handover_status", ["pending", "given"]);
export const paymentMethod = pgEnum("payment_method", ["cash", "transfer"]);
export const receiptStatus = pgEnum("receipt_status", ["active", "cancelled"]);
export const timesheetRole = pgEnum("timesheet_role", ["main", "substitute", "assistant"]);

export const students = pgTable(
  "students",
  {
    id: id(),
    code: text("code").notNull().unique(),
    fullName: text("full_name").notNull(),
    birthDate: date("birth_date"),
    gender: gender("gender"),
    schoolGrade: smallint("school_grade"),
    guardianName: text("guardian_name"),
    phone: text("phone"),
    status: studentStatus("status").notNull().default("active"),
    currentAvatarId: uuid("current_avatar_id").references((): AnyPgColumn => avatars.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("students_name_idx").on(t.fullName)],
);

export const courses = pgTable("courses", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  totalSessions: integer("total_sessions").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const rooms = pgTable("rooms", {
  id: id(),
  name: text("name").notNull().unique(),
  capacity: integer("capacity").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// Ca cố định: chỉ là giờ mặc định, buổi học sao chép giờ từ đây lúc sinh.
// Mỗi dòng là một khung giờ của một ca. Tên ca là một trong SLOT_NAMES (Ca sáng / Ca chiều / Ca tối).
export const timeSlots = pgTable(
  "time_slots",
  {
    id: id(),
    name: text("name").notNull(),
    /** Số khung trong ca (Khung 1, Khung 2…), Admin chọn khi thêm/sửa; không trùng trong cùng ca. */
    frame: smallint("frame").notNull(),
    defaultStart: time("default_start").notNull(),
    defaultEnd: time("default_end").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("time_slots_name_frame_no_uq").on(t.name, t.frame),
    check("time_slots_frame_range", sql`${t.frame} between 1 and 10`),
  ],
);

export const classes = pgTable(
  "classes",
  {
    id: id(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    // Lớp không còn gắn với một khóa (một lớp học lần lượt nhiều khóa; khóa chọn ở Syllabus). Cột giữ lại cho dữ liệu cũ,
    // không còn mã nào đọc hay ghi.
    courseId: uuid("course_id").references(() => courses.id, { onDelete: "set null" }),
    defaultRoomId: uuid("default_room_id").references(() => rooms.id),
    startDate: date("start_date").notNull(),
    endDate: date("end_date").notNull(),
    maxSize: integer("max_size").notNull(),
    // Học phí của lớp (đồng/học viên cho cả khóa); null = chưa đặt học phí.
    tuitionFee: integer("tuition_fee"),
    // true = lớp chỉ để giữ chỗ trên Thời khóa biểu (vd. cho mượn phòng): vẫn kiểm tra trùng phòng/giáo viên,
    // nhưng không có học viên nên không điểm danh, ghi sao, ghi danh, học phí, chấm công, báo cáo.
    timetableOnly: boolean("timetable_only").notNull().default(false),
    status: classStatus("status").notNull().default("open"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("classes_course_idx").on(t.courseId)],
);

// class_id null = nghỉ toàn trung tâm
export const holidays = pgTable(
  "holidays",
  {
    id: id(),
    date: date("date").notNull(),
    reason: text("reason").notNull(),
    classId: uuid("class_id").references(() => classes.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [index("holidays_date_idx").on(t.date)],
);

export const classTeachers = pgTable(
  "class_teachers",
  {
    id: id(),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => teachers.id),
    role: classTeacherRole("role").notNull().default("main"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("class_teachers_uniq").on(t.classId, t.teacherId),
    index("class_teachers_teacher_idx").on(t.teacherId),
  ],
);

export const enrollments = pgTable(
  "enrollments",
  {
    id: id(),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id),
    joinedAt: date("joined_at").notNull(),
    leftAt: date("left_at"),
    // Giảm học phí riêng của học viên ở lớp này (đồng) và lý do.
    feeDiscount: integer("fee_discount").notNull().default(0),
    feeDiscountReason: text("fee_discount_reason"),
    status: enrollmentStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("enrollments_class_student_idx").on(t.classId, t.studentId),
    index("enrollments_student_idx").on(t.studentId),
    // Một học viên chỉ có một ghi danh đang hiệu lực trong mỗi lớp.
    uniqueIndex("enrollments_active_uniq").on(t.classId, t.studentId).where(sql`${t.status} = 'active'`),
  ],
);

// Một lớp có nhiều dòng lịch mẫu mỗi tuần. weekday: 1 = Thứ Hai ... 7 = Chủ nhật (ISO).
export const scheduleTemplates = pgTable(
  "schedule_templates",
  {
    id: id(),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    weekday: smallint("weekday").notNull(),
    timeSlotId: uuid("time_slot_id")
      .notNull()
      .references(() => timeSlots.id),
    roomId: uuid("room_id").references(() => rooms.id),
    teacherId: uuid("teacher_id").references(() => teachers.id),
    assistantTeacherId: uuid("assistant_teacher_id").references(() => teachers.id),
    startTime: time("start_time"),
    endTime: time("end_time"),
    createdAt: createdAt(),
  },
  (t) => [
    index("schedule_templates_class_idx").on(t.classId),
    check("schedule_templates_weekday_chk", sql`${t.weekday} between 1 and 7`),
  ],
);

// Syllabus: chương trình dạy theo Lớp + Khóa học + Buổi (Tên bài/Chủ đề + Sản phẩm). Một lớp học lần lượt nhiều khóa nên
// cùng một lớp có Buổi 1 của khóa A và Buổi 1 của khóa B. Giáo viên chọn tên bài khi điểm danh.
export const syllabusLessons = pgTable(
  "syllabus_lessons",
  {
    id: id(),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id),
    // Buổi thứ mấy của khóa (cột "period" giữ tên cũ từ thời còn gọi là Tiết).
    period: integer("period").notNull(),
    title: text("title").notNull(),
    // Sản phẩm học viên làm ra trong buổi (không bắt buộc).
    product: text("product"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("syllabus_lessons_class_course_period_uq").on(t.classId, t.courseId, t.period),
    check("syllabus_lessons_period_chk", sql`${t.period} >= 1`),
  ],
);

// Lớp học thêm (lớp ngoài hệ thống, giữ phòng hằng tuần): tính năng đã gỡ khỏi ứng dụng, không còn mã nào đọc hay ghi bảng này.
// Bảng được giữ lại để không mất dữ liệu cũ; chỉ xóa bằng một migration riêng khi chủ hệ thống đồng ý.
export const extraClasses = pgTable(
  "extra_classes",
  {
    id: id(),
    name: text("name").notNull(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id),
    weekday: smallint("weekday").notNull(),
    // Ca + Khung giờ là một dòng time_slots.
    timeSlotId: uuid("time_slot_id")
      .notNull()
      .references(() => timeSlots.id),
    teacherId: uuid("teacher_id").references(() => teachers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("extra_classes_weekday_slot_idx").on(t.weekday, t.timeSlotId),
    check("extra_classes_weekday_chk", sql`${t.weekday} between 1 and 7`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    templateId: uuid("template_id").references(() => scheduleTemplates.id, { onDelete: "set null" }),
    date: date("date").notNull(),
    originalDate: date("original_date"),
    timeSlotId: uuid("time_slot_id").references(() => timeSlots.id),
    // Sao chép từ ca lúc sinh buổi, chỉnh riêng được từng buổi.
    startTime: time("start_time").notNull(),
    endTime: time("end_time").notNull(),
    roomId: uuid("room_id").references(() => rooms.id),
    teacherId: uuid("teacher_id").references(() => teachers.id),
    substituteTeacherId: uuid("substitute_teacher_id").references(() => teachers.id),
    assistantTeacherId: uuid("assistant_teacher_id").references(() => teachers.id),
    kind: sessionKind("kind").notNull().default("regular"),
    status: sessionStatus("status").notNull().default("planned"),
    content: text("content"),
    note: text("note"),
    // Nhận xét chung của giáo viên sau buổi dạy (nhập ở trang điểm danh).
    teacherRemark: text("teacher_remark"),
    attendanceUnlockedUntil: timestamp("attendance_unlocked_until", { withTimezone: true }),
    attendanceUnlockedBy: text("attendance_unlocked_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sessions_date_idx").on(t.date),
    index("sessions_class_date_idx").on(t.classId, t.date),
    index("sessions_teacher_date_idx").on(t.teacherId, t.date),
    index("sessions_substitute_date_idx").on(t.substituteTeacherId, t.date),
    index("sessions_assistant_date_idx").on(t.assistantTeacherId, t.date),
    index("sessions_room_date_idx").on(t.roomId, t.date),
    // Sinh buổi lặp lại không tạo trùng. Buổi đã dời giữ original_date nên dùng ngày gốc.
    uniqueIndex("sessions_template_origin_uniq").on(t.templateId, sql`coalesce(${t.originalDate}, ${t.date})`),
    check("sessions_time_chk", sql`${t.startTime} < ${t.endTime}`),
  ],
);

// Buổi bù chỉ gồm học viên được chọn.
export const sessionStudents = pgTable(
  "session_students",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id),
  },
  (t) => [uniqueIndex("session_students_uniq").on(t.sessionId, t.studentId)],
);

export const attendances = pgTable(
  "attendances",
  {
    id: id(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id),
    status: attendanceStatus("status").notNull().default("present"),
    note: text("note"),
    recordedBy: text("recorded_by").references(() => user.id, { onDelete: "set null" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("attendances_session_student_uniq").on(t.sessionId, t.studentId),
    index("attendances_student_idx").on(t.studentId),
  ],
);

// Học bù: học viên vắng một buổi được xếp học ghép vào một buổi có sẵn khác (cùng lớp hoặc lớp khác).
// Em có tên trong bảng điểm danh và ghi sao của buổi học bù; không tính vào sĩ số lớp đó.
export const makeupAssignments = pgTable(
  "makeup_assignments",
  {
    id: id(),
    absentSessionId: uuid("absent_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    makeupSessionId: uuid("makeup_session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    // Mỗi buổi vắng của một học viên chỉ xếp bù một lần; một em không học bù hai lần trong cùng một buổi.
    uniqueIndex("makeup_assignments_absent_uniq").on(t.absentSessionId, t.studentId),
    uniqueIndex("makeup_assignments_makeup_uniq").on(t.makeupSessionId, t.studentId),
    index("makeup_assignments_student_idx").on(t.studentId),
    check("makeup_assignments_distinct_chk", sql`${t.absentSessionId} <> ${t.makeupSessionId}`),
  ],
);

export const starCriteria = pgTable("star_criteria", {
  id: id(),
  name: text("name").notNull(),
  stars: integer("stars").notNull(),
  type: criteriaType("type").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

// Sổ cái: chỉ thêm. Hoàn tác = thêm bản ghi đảo dấu trỏ về bản gốc qua reverses_log_id.
export const starLogs = pgTable(
  "star_logs",
  {
    id: id(),
    sessionId: uuid("session_id").references(() => sessions.id),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id),
    criteriaId: uuid("criteria_id").references(() => starCriteria.id),
    stars: integer("stars").notNull(),
    note: text("note"),
    reversesLogId: uuid("reverses_log_id").references((): AnyPgColumn => starLogs.id),
    recordedBy: text("recorded_by").references(() => user.id, { onDelete: "set null" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("star_logs_student_idx").on(t.studentId),
    index("star_logs_session_student_idx").on(t.sessionId, t.studentId),
    uniqueIndex("star_logs_reverses_uniq").on(t.reversesLogId),
  ],
);

// Cấp bậc và avatar (levels, avatars, student_avatar_gifts, students.current_avatar_id): tính năng đã gỡ khỏi ứng dụng,
// không còn mã nào đọc hay ghi. Các bảng được giữ lại để không mất dữ liệu cũ; chỉ xóa bằng một migration riêng khi chủ hệ thống đồng ý.
export const levels = pgTable("levels", {
  id: id(),
  levelNo: integer("level_no").notNull().unique(),
  name: text("name").notNull(),
  minStars: integer("min_stars").notNull(),
  frameColor: text("frame_color").notNull(),
});

export const avatars = pgTable("avatars", {
  id: id(),
  name: text("name").notNull(),
  svgPath: text("svg_path").notNull().unique(),
  requiredLevelId: uuid("required_level_id").references(() => levels.id),
  unlockType: avatarUnlockType("unlock_type").notNull().default("by_level"),
  active: boolean("active").notNull().default(true),
});

// Avatar Admin tặng riêng: không mất khi tụt cấp.
export const studentAvatarGifts = pgTable(
  "student_avatar_gifts",
  {
    id: id(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    avatarId: uuid("avatar_id")
      .notNull()
      .references(() => avatars.id),
    giftedBy: text("gifted_by").references(() => user.id, { onDelete: "set null" }),
    giftedAt: timestamp("gifted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("student_avatar_gifts_uniq").on(t.studentId, t.avatarId)],
);

export const gifts = pgTable("gifts", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  stock: integer("stock").notNull().default(0),
});

// Mốc quà đặt theo lớp. Cột course_id là của mốc quà theo khóa học trước đây (đã chép sang từng lớp ở migration 0027),
// không còn mã nào đọc hay ghi.
export const rewardTiers = pgTable(
  "reward_tiers",
  {
    id: id(),
    courseId: uuid("course_id").references(() => courses.id, { onDelete: "cascade" }),
    classId: uuid("class_id").references(() => classes.id, { onDelete: "cascade" }),
    minStars: integer("min_stars").notNull(),
    giftId: uuid("gift_id")
      .notNull()
      .references(() => gifts.id),
  },
  (t) => [check("reward_tiers_scope_chk", sql`(${t.courseId} is null) <> (${t.classId} is null)`)],
);

export const courseSummaries = pgTable(
  "course_summaries",
  {
    id: id(),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id),
    totalStars: integer("total_stars").notNull(),
    attendanceRate: numeric("attendance_rate", { precision: 5, scale: 2 }).notNull(),
    rank: integer("rank").notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("course_summaries_uniq").on(t.classId, t.studentId)],
);

export const giftHandovers = pgTable(
  "gift_handovers",
  {
    id: id(),
    summaryId: uuid("summary_id")
      .notNull()
      .references(() => courseSummaries.id, { onDelete: "cascade" }),
    giftId: uuid("gift_id")
      .notNull()
      .references(() => gifts.id),
    status: handoverStatus("status").notNull().default("pending"),
    givenAt: timestamp("given_at", { withTimezone: true }),
    givenBy: text("given_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [uniqueIndex("gift_handovers_summary_uniq").on(t.summaryId)],
);

// Đổi quà trong khóa học: mỗi dòng là một lần đổi, `stars` là số sao đã dùng (chụp từ mốc quà lúc đổi).
// Sao còn lại của học viên = tổng sao tích lũy − tổng `stars` ở bảng này; tổng tích lũy và cấp bậc không đổi.
export const giftRedemptions = pgTable(
  "gift_redemptions",
  {
    id: id(),
    studentId: uuid("student_id")
      .notNull()
      .references(() => students.id, { onDelete: "cascade" }),
    classId: uuid("class_id").references(() => classes.id, { onDelete: "set null" }),
    giftId: uuid("gift_id")
      .notNull()
      .references(() => gifts.id),
    stars: integer("stars").notNull(),
    redeemedBy: text("redeemed_by").references(() => user.id, { onDelete: "set null" }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("gift_redemptions_student_idx").on(t.studentId), check("gift_redemptions_stars_chk", sql`${t.stars} > 0`)],
);

// Phiếu thu học phí: mỗi lần phụ huynh đóng tiền cho một lượt ghi danh là một phiếu. Phiếu không bị xóa, chỉ hủy.
// Đã đóng của học viên ở một lớp = tổng `amount` của các phiếu còn hiệu lực.
export const tuitionReceipts = pgTable(
  "tuition_receipts",
  {
    id: id(),
    // Số phiếu tăng dần, in dạng PT-000123.
    receiptNo: integer("receipt_no").notNull().generatedAlwaysAsIdentity().unique(),
    enrollmentId: uuid("enrollment_id")
      .notNull()
      .references(() => enrollments.id),
    amount: integer("amount").notNull(),
    method: paymentMethod("method").notNull(),
    paidAt: date("paid_at").notNull(),
    payerName: text("payer_name"),
    note: text("note"),
    collectedBy: text("collected_by").references(() => user.id, { onDelete: "set null" }),
    status: receiptStatus("status").notNull().default("active"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledBy: text("cancelled_by").references(() => user.id, { onDelete: "set null" }),
    cancelReason: text("cancel_reason"),
    createdAt: createdAt(),
  },
  (t) => [index("tuition_receipts_enrollment_idx").on(t.enrollmentId), check("tuition_receipts_amount_chk", sql`${t.amount} > 0`)],
);

// Mua sắm: khoản chi của trung tâm, nhập ở Báo cáo → Mua sắm. Thành tiền = số lượng × đơn giá (tính khi đọc).
export const purchases = pgTable(
  "purchases",
  {
    id: id(),
    purchasedAt: date("purchased_at").notNull(),
    item: text("item").notNull(),
    // Nhóm chi do người dùng tự gõ (vd. Thiết bị, Học cụ, Văn phòng phẩm).
    category: text("category").notNull(),
    quantity: integer("quantity").notNull(),
    unitPrice: integer("unit_price").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("purchases_date_idx").on(t.purchasedAt),
    check("purchases_quantity_chk", sql`${t.quantity} >= 1`),
    check("purchases_unit_price_chk", sql`${t.unitPrice} >= 0`),
  ],
);

// Mức lương mỗi buổi (công) của một giáo viên/trợ giảng ở một lớp, đặt ở Chấm công → Mức lương giáo viên/Nhân viên.
// Không phụ thuộc phân công: đặt được cho cả người dạy thay hay có công bổ sung ở lớp đó.
export const teacherRates = pgTable(
  "teacher_rates",
  {
    id: id(),
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => teachers.id, { onDelete: "cascade" }),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    rate: integer("rate").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("teacher_rates_teacher_class_uq").on(t.teacherId, t.classId), check("teacher_rates_rate_chk", sql`${t.rate} >= 0`)],
);

// Công bổ sung: dòng công ghi tay cho giáo viên, chỉ nằm ở bảng Chấm công (không tạo buổi học, không điểm danh).
export const timesheetEntries = pgTable(
  "timesheet_entries",
  {
    id: id(),
    teacherId: uuid("teacher_id")
      .notNull()
      .references(() => teachers.id),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    // Ca + Khung giờ là một dòng time_slots.
    timeSlotId: uuid("time_slot_id")
      .notNull()
      .references(() => timeSlots.id),
    role: timesheetRole("role").notNull().default("main"),
    note: text("note"),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("timesheet_entries_date_idx").on(t.date), index("timesheet_entries_teacher_idx").on(t.teacherId)],
);

// Phần sửa của một dòng công sinh từ buổi học: chỉ đổi Ngày / Ca – Khung giờ / Lớp trên bảng Chấm công,
// buổi học (Thời khóa biểu, điểm danh) giữ nguyên. `part`: lead = người thực dạy, assistant = trợ giảng.
export const timesheetOverrides = pgTable(
  "timesheet_overrides",
  {
    id: id(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    part: text("part").notNull(),
    date: date("date").notNull(),
    // null = giữ giờ của buổi học (buổi không gắn ca).
    timeSlotId: uuid("time_slot_id").references(() => timeSlots.id),
    classId: uuid("class_id")
      .notNull()
      .references(() => classes.id, { onDelete: "cascade" }),
    note: text("note"),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("timesheet_overrides_session_part_uq").on(t.sessionId, t.part),
    index("timesheet_overrides_date_idx").on(t.date),
    check("timesheet_overrides_part_chk", sql`${t.part} in ('lead', 'assistant')`),
  ],
);
