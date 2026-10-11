import { and, asc, count, desc, eq, gte, inArray, like, lt, sql } from "drizzle-orm";
import type { z } from "zod";
import { db, type Tx } from "@/db";
import {
  attendances,
  classTeachers,
  classes,
  courseSummaries,
  enrollments,
  rooms,
  scheduleTemplates,
  sessionStudents,
  sessions,
  starLogs,
  students,
  syllabusLessons,
  teacherRates,
  teachers,
  timeSlots,
  timesheetEntries,
  tuitionReceipts,
} from "@/db/schema";
import { classCodeYearPrefix, nextClassCode } from "@/domain/student-code";
import { ROSTER_NO_TEACHER_SHADE, rosterSessionLabel, rosterSessionOrder, rosterTeacherShade } from "@/domain/roster";
import { todayIso } from "@/lib/format";
import type { classInput, enrollInput, leaveInput, newEnrollmentInput } from "@/lib/validation/entities";
import { audit } from "../audit";
import { AppError, notFound, translateDbError } from "../errors";
import { type Actor, allowedClassIds, assertAdmin, assertCan, assertCanAny, assertClassAccess, assertNotTimetableOnly } from "../guard";
import { deleteRow, updateRow } from "./crud";
import { purgeAllStudentStarLogs, purgeStudentStarLogs } from "./stars";
import { insertStudent } from "./students";

const activeCount = sql<number>`(
  select count(*)::int from ${enrollments}
  where ${enrollments.classId} = ${classes.id} and ${enrollments.status} = 'active'
)`;

/**
 * Chỉ các lớp trong phạm vi của người dùng (Admin và phạm vi "Tất cả lớp": mọi lớp).
 * Lớp "chỉ hiển thị trên Thời khóa biểu" mặc định bị bỏ qua; chỉ trang Lớp học, Thời khóa biểu và ngày nghỉ bật `includeTimetableOnly`.
 */
export async function listClasses(actor: Actor, { includeTimetableOnly = false }: { includeTimetableOnly?: boolean } = {}) {
  const allowed = await allowedClassIds(actor);
  if (allowed && allowed.length === 0) return [];
  return db
    .select({
      id: classes.id,
      code: classes.code,
      name: classes.name,
      defaultRoomId: classes.defaultRoomId,
      roomName: rooms.name,
      startDate: classes.startDate,
      endDate: classes.endDate,
      maxSize: classes.maxSize,
      status: classes.status,
      timetableOnly: classes.timetableOnly,
      studentCount: activeCount,
    })
    .from(classes)
    .leftJoin(rooms, eq(rooms.id, classes.defaultRoomId))
    .where(and(allowed ? inArray(classes.id, allowed) : undefined, includeTimetableOnly ? undefined : eq(classes.timetableOnly, false)))
    // Khóa bắt đầu trước xếp trước; cùng ngày thì theo mã lớp.
    .orderBy(asc(classes.startDate), asc(classes.code));
}

export async function getClass(actor: Actor, classId: string) {
  await assertClassAccess(actor, classId);
  const [row] = await db
    .select({
      id: classes.id,
      code: classes.code,
      name: classes.name,
      defaultRoomId: classes.defaultRoomId,
      roomName: rooms.name,
      startDate: classes.startDate,
      endDate: classes.endDate,
      maxSize: classes.maxSize,
      status: classes.status,
      timetableOnly: classes.timetableOnly,
    })
    .from(classes)
    .leftJoin(rooms, eq(rooms.id, classes.defaultRoomId))
    .where(eq(classes.id, classId))
    .limit(1);
  if (!row) throw notFound("lớp học");
  return row;
}

/** Mã lớp tự cấp kế tiếp của năm hiện tại (RB2601, RB2602, …). */
async function nextCodeOf(tx: Tx, now: Date): Promise<string> {
  const year = Number(todayIso(now).slice(0, 4));
  const rows = await tx.select({ code: classes.code }).from(classes).where(like(classes.code, `${classCodeYearPrefix(year)}%`));
  return nextClassCode(rows.map((r) => r.code), year);
}

/** Thêm lớp: mã lớp luôn do máy chủ cấp (mã kế tiếp của năm), không nhận từ form và không sửa được về sau. */
export async function createClass(actor: Actor, data: z.output<typeof classInput>, now: Date = new Date()) {
  assertCan(actor, "classes", "add");
  try {
    return await db.transaction(async (tx) => {
      // Hai người thêm cùng lúc không nhận trùng một mã tự cấp.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('class_code'))`);
      const [row] = await tx.insert(classes).values({ ...data, code: await nextCodeOf(tx, now) }).returning();
      await audit(tx, { userId: actor.userId, action: "create", tableName: "classes", recordId: row!.id, newValue: row });
      return row!;
    });
  } catch (e) {
    throw translateDbError(e);
  }
}
export async function updateClass(actor: Actor, id: string, data: z.output<typeof classInput>) {
  assertCan(actor, "classes", "edit");
  await assertClassAccess(actor, id);
  if (data.timetableOnly) await assertCanBeTimetableOnly(id);
  return updateRow(actor, classes, "classes", id, data, "classes");
}

/**
 * Chỉ chuyển lớp sang "chỉ hiển thị trên Thời khóa biểu" khi lớp chưa có dữ liệu của học viên hay chấm công,
 * vì các dữ liệu đó sẽ bị ẩn khỏi mọi trang.
 */
async function assertCanBeTimetableOnly(classId: string) {
  const [current] = await db.select({ timetableOnly: classes.timetableOnly }).from(classes).where(eq(classes.id, classId)).limit(1);
  if (!current || current.timetableOnly) return;
  const n = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0;
  const ofClass = eq(sessions.classId, classId);
  const [enrolled, attended, stars, rates, entries, lessons] = await Promise.all([
    n(db.select({ n: count() }).from(enrollments).where(eq(enrollments.classId, classId))),
    n(db.select({ n: count() }).from(sessions).where(and(ofClass, eq(sessions.status, "done")))),
    n(db.select({ n: count() }).from(starLogs).innerJoin(sessions, eq(sessions.id, starLogs.sessionId)).where(ofClass)),
    n(db.select({ n: count() }).from(teacherRates).where(eq(teacherRates.classId, classId))),
    n(db.select({ n: count() }).from(timesheetEntries).where(eq(timesheetEntries.classId, classId))),
    n(db.select({ n: count() }).from(syllabusLessons).where(eq(syllabusLessons.classId, classId))),
  ]);
  const blockers = [
    enrolled && `${enrolled} lượt ghi danh`,
    attended && `${attended} buổi đã điểm danh`,
    stars && `${stars} lần ghi sao`,
    rates && `${rates} mức lương giáo viên`,
    entries && `${entries} công bổ sung`,
    lessons && `${lessons} bài học Syllabus`,
  ].filter(Boolean);
  if (blockers.length > 0) {
    const message = `Lớp đã có ${blockers.join(", ")} nên chưa chuyển sang "Chỉ trên Thời khóa biểu" được. Hãy xóa các dữ liệu đó trước, hoặc tạo một lớp mới.`;
    throw new AppError("CONFLICT", message, { timetableOnly: "Lớp đã có dữ liệu" });
  }
}

export async function deleteClass(actor: Actor, id: string) {
  assertAdmin(actor);
  const [used] = await db.select({ n: count() }).from(sessions).where(eq(sessions.classId, id));
  if (used && used.n > 0) throw new AppError("CONFLICT", "Lớp đã có buổi học nên không thể xóa.");
  return deleteRow(actor, classes, "classes", id);
}

/** Giáo viên của lớp. Danh sách này được ghi tự động theo lịch mẫu của lớp (GV chính, trợ giảng của từng dòng). */
export async function listClassTeachers(actor: Actor, classId: string) {
  await assertClassAccess(actor, classId);
  return db
    .select({
      id: classTeachers.id,
      teacherId: teachers.id,
      code: teachers.code,
      fullName: teachers.fullName,
      role: classTeachers.role,
    })
    .from(classTeachers)
    .innerJoin(teachers, eq(teachers.id, classTeachers.teacherId))
    .where(eq(classTeachers.classId, classId))
    .orderBy(asc(classTeachers.role), asc(teachers.fullName));
}

/**
 * Tổng quan Ghi danh theo buổi học trong tuần: mỗi lớp đang mở là một khung, liệt kê các buổi (thứ + ca) trong tuần của lớp
 * kèm giờ học, giáo viên và học viên đang học của lớp (chỉ họ tên và khối). Lớp học nhiều buổi/tuần với cùng một giáo viên
 * gom về một khung; buổi do giáo viên khác dạy là khung riêng.
 * Buổi lấy từ LỊCH MẪU của lớp (giáo viên của dòng lịch mẫu, không ghi thì GV chính của lớp), không đọc Thời khóa biểu:
 * buổi học được sinh theo từng tuần nên bảng này không phụ thuộc tuần đó đã sinh buổi hay chưa, cũng không đổi theo dạy thay, buổi dời.
 * Chỉ các lớp trong phạm vi của người dùng; không gồm lớp đã đóng và lớp chỉ hiển thị trên Thời khóa biểu.
 */
export async function weeklyRoster(actor: Actor) {
  assertCan(actor, "enrollments", "view");
  const open = (await listClasses(actor)).filter((c) => c.status === "open");
  if (open.length === 0) return { blocks: [], unscheduled: [] };
  const ids = open.map((c) => c.id);
  const [templates, mains, active, teacherOrder] = await Promise.all([
    db
      .select({
        classId: scheduleTemplates.classId,
        weekday: scheduleTemplates.weekday,
        slotName: timeSlots.name,
        startTime: sql<string>`coalesce(${scheduleTemplates.startTime}, ${timeSlots.defaultStart})`,
        endTime: sql<string>`coalesce(${scheduleTemplates.endTime}, ${timeSlots.defaultEnd})`,
        teacherId: teachers.id,
        teacherShort: teachers.shortName,
        teacherName: teachers.fullName,
      })
      .from(scheduleTemplates)
      .innerJoin(timeSlots, eq(timeSlots.id, scheduleTemplates.timeSlotId))
      .leftJoin(teachers, eq(teachers.id, scheduleTemplates.teacherId))
      .where(inArray(scheduleTemplates.classId, ids)),
    db
      .select({ classId: classTeachers.classId, teacherId: teachers.id, teacherShort: teachers.shortName, teacherName: teachers.fullName })
      .from(classTeachers)
      .innerJoin(teachers, eq(teachers.id, classTeachers.teacherId))
      .where(and(inArray(classTeachers.classId, ids), eq(classTeachers.role, "main")))
      .orderBy(asc(teachers.code)),
    db
      .select({
        classId: enrollments.classId,
        enrollmentId: enrollments.id,
        id: students.id,
        fullName: students.fullName,
        schoolGrade: students.schoolGrade,
      })
      .from(enrollments)
      .innerJoin(students, eq(students.id, enrollments.studentId))
      .where(and(inArray(enrollments.classId, ids), eq(enrollments.status, "active")))
      // Theo ngày vào lớp: học viên mới thêm nằm ở hàng trống kế tiếp.
      .orderBy(asc(enrollments.joinedAt), asc(enrollments.createdAt), asc(students.fullName)),
    // Thứ tự giáo viên để chọn tông màu: như Thời khóa biểu (giáo viên đang dạy xếp theo mã), người đã nghỉ xếp sau.
    db.select({ id: teachers.id, status: teachers.status }).from(teachers).orderBy(asc(teachers.code)),
  ]);

  // Tên giáo viên hiển thị: tên viết tắt nếu có, không thì họ tên.
  type Teacher = { id: string; name: string };
  const shown = (id: string | null, short: string | null, full: string | null): Teacher | null => (id ? { id, name: short || full || "" } : null);
  const mainOf = new Map<string, Teacher | null>();
  for (const m of mains) if (!mainOf.has(m.classId)) mainOf.set(m.classId, shown(m.teacherId, m.teacherShort, m.teacherName));

  type Slot = { classId: string; weekday: number; slotName: string; startTime: string; endTime: string; teacher: Teacher | null };
  const slots: Slot[] = templates.map((t) => ({ ...t, teacher: shown(t.teacherId, t.teacherShort, t.teacherName) ?? mainOf.get(t.classId) ?? null }));

  // Nhiều khung giờ của cùng một ca trong cùng một ngày là một buổi: giờ từ khung sớm nhất tới khung muộn nhất.
  const merged = new Map<string, Slot>();
  for (const slot of slots.sort((a, b) => a.startTime.localeCompare(b.startTime))) {
    const key = `${slot.classId}|${slot.weekday}|${slot.slotName}`;
    const first = merged.get(key);
    if (!first) merged.set(key, { ...slot });
    else {
      if (slot.endTime > first.endTime) first.endTime = slot.endTime;
      first.teacher ??= slot.teacher;
    }
  }

  // `enrollmentId`: lượt ghi danh đang hiệu lực của em ở lớp, để cho rời lớp hoặc xóa khỏi lớp ngay trên bảng.
  const studentsOf = (classId: string) =>
    active
      .filter((s) => s.classId === classId)
      .map((s) => ({ id: s.id, enrollmentId: s.enrollmentId, fullName: s.fullName, schoolGrade: s.schoolGrade }));
  const classOf = new Map(open.map((c) => [c.id, c]));
  // Cùng một lớp, cùng giáo viên: các buổi trong tuần gom về một khung (lớp học nhiều buổi/tuần chỉ một bảng học viên).
  const grouped = new Map<string, Slot[]>();
  for (const slot of merged.values()) {
    const key = `${slot.classId}|${slot.teacher?.id ?? ""}`;
    grouped.set(key, [...(grouped.get(key) ?? []), slot]);
  }
  const placed = [...grouped.entries()]
    .map(([key, slots]) => {
      const cls = classOf.get(slots[0]!.classId)!;
      const teacher = slots[0]!.teacher;
      return {
        key,
        // Các buổi của khung theo thứ tự trong tuần: buổi sớm hơn nằm trên.
        sessions: slots
          .map((slot) => ({
            label: rosterSessionLabel(slot.slotName, slot.weekday),
            order: rosterSessionOrder(slot.slotName, slot.weekday),
            startTime: slot.startTime,
            endTime: slot.endTime,
          }))
          .sort((a, b) => a.order - b.order || a.startTime.localeCompare(b.startTime)),
        teacherId: teacher?.id ?? null,
        teacherName: teacher?.name || null,
        classId: cls.id,
        classCode: cls.code,
        className: cls.name,
        startDate: cls.startDate,
        maxSize: cls.maxSize,
        students: studentsOf(cls.id),
      };
    })
    // Khung đứng theo buổi đầu tiên trong tuần của nó; cùng một buổi thì lớp học sớm hơn đứng trước.
    .sort((a, b) => {
      const [x, y] = [a.sessions[0]!, b.sessions[0]!];
      return x.order - y.order || x.startTime.localeCompare(y.startTime) || a.classCode.localeCompare(b.classCode, "vi");
    });

  // Màu khung: mỗi giáo viên một tông; các khung của cùng một người xen kẽ nhạt – đậm theo thứ tự trong tuần
  // (khung chẵn lấy nửa nhạt, khung lẻ lấy nửa đậm) để hai khung kề nhau luôn khác rõ.
  const ordered = [...teacherOrder.filter((t) => t.status === "active"), ...teacherOrder.filter((t) => t.status !== "active")];
  const toneOf = new Map(ordered.map((t, index) => [t.id, index]));
  const perTeacher = new Map<string, number>();
  for (const block of placed) if (block.teacherId) perTeacher.set(block.teacherId, (perTeacher.get(block.teacherId) ?? 0) + 1);
  const seen = new Map<string, number>();
  const blocks = placed.map((block) => {
    if (!block.teacherId) return { ...block, shade: ROSTER_NO_TEACHER_SHADE };
    const position = seen.get(block.teacherId) ?? 0;
    seen.set(block.teacherId, position + 1);
    const count = perTeacher.get(block.teacherId)!;
    const level = position % 2 === 0 ? position / 2 : Math.ceil(count / 2) + (position - 1) / 2;
    return { ...block, shade: rosterTeacherShade(toneOf.get(block.teacherId) ?? 0, level, count) };
  });
  const scheduled = new Set(blocks.map((block) => block.classId));
  return {
    blocks,
    /** Lớp đang mở chưa có lịch mẫu nên chưa thuộc buổi nào. */
    unscheduled: open.filter((c) => !scheduled.has(c.id)).map((c) => ({ id: c.id, code: c.code, name: c.name })),
  };
}

/** Toàn bộ lịch sử ghi danh của lớp. */
export async function listEnrollments(actor: Actor, classId: string) {
  assertCanAny(actor, ["enrollments", "view"], ["classes", "view"]);
  await assertClassAccess(actor, classId);
  return db
    .select({
      id: enrollments.id,
      studentId: students.id,
      code: students.code,
      fullName: students.fullName,
      joinedAt: enrollments.joinedAt,
      leftAt: enrollments.leftAt,
      status: enrollments.status,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .where(eq(enrollments.classId, classId))
    // Theo mã học viên; cùng một em ghi danh nhiều lần thì lần mới nhất đứng trước.
    .orderBy(asc(students.code), desc(enrollments.joinedAt));
}

/** Ghi danh trong một giao dịch có sẵn (người gọi đã kiểm tra quyền và phạm vi lớp). */
async function enrollInTx(tx: Tx, actor: Actor, data: z.output<typeof enrollInput>) {
  // Khóa dòng lớp để hai thao tác ghi danh đồng thời không vượt sĩ số.
  const [cls] = await tx.select().from(classes).where(eq(classes.id, data.classId)).for("update").limit(1);
  if (!cls) throw notFound("lớp học");
  if (cls.status !== "open") throw new AppError("CONFLICT", "Lớp đã đóng, không thể ghi danh.");
  await assertNotTimetableOnly(cls.id, tx);
  const [student] = await tx.select().from(students).where(eq(students.id, data.studentId)).limit(1);
  if (!student) throw notFound("học viên");
  if (student.status === "left") throw new AppError("CONFLICT", "Học viên đã nghỉ hẳn, không thể ghi danh.");
  const [current] = await tx
    .select({ n: count() })
    .from(enrollments)
    .where(and(eq(enrollments.classId, data.classId), eq(enrollments.status, "active")));
  if ((current?.n ?? 0) >= cls.maxSize) {
    throw new AppError("CONFLICT", `Lớp đã đủ sĩ số tối đa (${cls.maxSize}).`);
  }
  const [row] = await tx.insert(enrollments).values({ ...data, status: "active" }).returning();
  await audit(tx, { userId: actor.userId, action: "create", tableName: "enrollments", recordId: row!.id, newValue: row });
  return row!;
}

export async function enrollStudent(actor: Actor, data: z.output<typeof enrollInput>) {
  assertCan(actor, "enrollments", "add");
  await assertClassAccess(actor, data.classId);
  try {
    return await db.transaction((tx) => enrollInTx(tx, actor, data));
  } catch (e) {
    const err = translateDbError(e);
    if (err instanceof AppError && err.code === "CONFLICT" && err.message.startsWith("Dữ liệu bị trùng")) {
      throw new AppError("CONFLICT", "Học viên đã ghi danh lớp này.");
    }
    throw err;
  }
}

/**
 * Nhận học viên mới ở trang Ghi danh: tạo học viên và ghi danh vào lớp trong cùng một giao dịch
 * (lớp đủ chỗ, đã đóng… thì không tạo dở học viên). Không chọn lớp thì chỉ tạo học viên, em nằm ở danh sách chờ lớp.
 * Ghi danh là nơi nhập học viên: chỉ cần quyền Thêm của menu Ghi danh.
 */
export async function enrollNewStudent(actor: Actor, data: z.output<typeof newEnrollmentInput>, now: Date = new Date()) {
  assertCan(actor, "enrollments", "add");
  const { classId, joinedAt, ...student } = data;
  if (classId) await assertClassAccess(actor, classId);
  try {
    return await db.transaction(async (tx) => {
      const created = await insertStudent(tx, actor, student, now);
      const enrollment = classId ? await enrollInTx(tx, actor, { classId, studentId: created.id, joinedAt: joinedAt! }) : null;
      return { studentId: created.id, code: created.code, enrollmentId: enrollment?.id ?? null };
    });
  } catch (e) {
    throw translateDbError(e);
  }
}

/** Cho học viên rời lớp từ ngày `leftAt` (giữ lịch sử, không xóa). */
export async function leaveEnrollment(actor: Actor, data: z.output<typeof leaveInput>) {
  assertCan(actor, "enrollments", "edit");
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(enrollments).where(eq(enrollments.id, data.id)).limit(1);
    if (!before) throw notFound("ghi danh");
    await assertClassAccess(actor, before.classId, tx);
    if (before.status !== "active") throw new AppError("CONFLICT", "Ghi danh này đã kết thúc.");
    if (data.leftAt < before.joinedAt) {
      throw new AppError("VALIDATION", "Ngày rời lớp phải sau ngày vào lớp.", { leftAt: "Phải sau ngày vào lớp" });
    }
    const [row] = await tx
      .update(enrollments)
      .set({ leftAt: data.leftAt, status: "left", updatedAt: new Date() })
      .where(eq(enrollments.id, data.id))
      .returning();
    await audit(tx, {
      userId: actor.userId,
      action: "update",
      tableName: "enrollments",
      recordId: data.id,
      oldValue: before,
      newValue: row,
    });
    return row!;
  });
}

/**
 * Xóa hẳn một dòng ghi danh nhập sai (chỉ Admin), kèm điểm danh và lịch sử sao của học viên ở các buổi
 * của lớp trong thời gian ghi danh đó.
 */
export async function deleteEnrollment(actor: Actor, id: string) {
  assertAdmin(actor);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(enrollments).where(eq(enrollments.id, id)).limit(1);
    if (!before) throw notFound("ghi danh");
    const [cls] = await tx.select({ status: classes.status }).from(classes).where(eq(classes.id, before.classId)).limit(1);
    if (cls?.status !== "open") throw new AppError("CONFLICT", "Lớp đã đóng và đã chốt tổng kết nên không xóa ghi danh được.");
    const [receipt] = await tx.select({ id: tuitionReceipts.id }).from(tuitionReceipts).where(eq(tuitionReceipts.enrollmentId, id)).limit(1);
    if (receipt) throw new AppError("CONFLICT", "Lượt ghi danh này đã có phiếu thu học phí nên không xóa được.");

    const inPeriod = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.classId, before.classId),
          gte(sessions.date, before.joinedAt),
          before.leftAt ? lt(sessions.date, before.leftAt) : undefined,
        ),
      );
    const sessionIds = inPeriod.map((r) => r.id);
    const removed =
      sessionIds.length === 0
        ? []
        : await tx
            .delete(attendances)
            .where(and(eq(attendances.studentId, before.studentId), inArray(attendances.sessionId, sessionIds)))
            .returning({ id: attendances.id });
    const deletedStarLogs = await purgeStudentStarLogs(tx, actor, before.studentId, sessionIds);

    await tx.delete(enrollments).where(eq(enrollments.id, id));
    await audit(tx, {
      userId: actor.userId,
      action: "delete",
      tableName: "enrollments",
      recordId: id,
      oldValue: before,
      newValue: { deletedAttendances: removed.length, deletedStarLogs },
    });
    return { deletedAttendances: removed.length, deletedStarLogs };
  });
}

/**
 * Xóa hẳn một học viên (chỉ Admin). Thứ tự bắt buộc: em phải rời hết các lớp trước (cho rời lớp hoặc xóa khỏi lớp ở Ghi danh);
 * khi đó xóa em cùng các lượt ghi danh cũ, điểm danh và lịch sử sao. Không xóa được khi em có dữ liệu ở lớp đã đóng
 * (tổng kết đã chốt theo số liệu đó) hoặc đã có phiếu thu học phí.
 */
export async function deleteStudent(actor: Actor, id: string) {
  assertAdmin(actor);
  try {
    return await db.transaction(async (tx) => {
      const [student] = await tx.select().from(students).where(eq(students.id, id)).for("update").limit(1);
      if (!student) throw notFound("học viên");
      const enrolled = await tx
        .select({ id: enrollments.id, status: enrollments.status, classCode: classes.code, classStatus: classes.status })
        .from(enrollments)
        .innerJoin(classes, eq(classes.id, enrollments.classId))
        .where(eq(enrollments.studentId, id))
        .orderBy(asc(classes.code));

      // Lớp đã đóng: ghi danh, tổng kết, hoặc điểm danh/sao (kể cả buổi học ghép) ở lớp đó.
      const [summary] = await tx.select({ id: courseSummaries.id }).from(courseSummaries).where(eq(courseSummaries.studentId, id)).limit(1);
      const [closedAttendance] = await tx
        .select({ id: attendances.id })
        .from(attendances)
        .innerJoin(sessions, eq(sessions.id, attendances.sessionId))
        .innerJoin(classes, eq(classes.id, sessions.classId))
        .where(and(eq(attendances.studentId, id), eq(classes.status, "closed")))
        .limit(1);
      const [closedStars] = await tx
        .select({ id: starLogs.id })
        .from(starLogs)
        .innerJoin(sessions, eq(sessions.id, starLogs.sessionId))
        .innerJoin(classes, eq(classes.id, sessions.classId))
        .where(and(eq(starLogs.studentId, id), eq(classes.status, "closed")))
        .limit(1);
      if (summary || closedAttendance || closedStars || enrolled.some((e) => e.classStatus === "closed")) {
        throw new AppError("CONFLICT", "Học viên có dữ liệu ở lớp đã đóng (đã chốt tổng kết) nên không xóa được. Hãy đổi trạng thái thành “Đã nghỉ”.");
      }

      const active = enrolled.filter((e) => e.status === "active");
      if (active.length > 0) {
        throw new AppError(
          "CONFLICT",
          `Học viên đang học lớp ${active.map((e) => e.classCode).join(", ")}. Hãy cho rời lớp hoặc xóa khỏi lớp ở Ghi danh trước khi xóa học viên.`,
        );
      }

      const enrollmentIds = enrolled.map((e) => e.id);
      if (enrollmentIds.length > 0) {
        const [receipt] = await tx
          .select({ id: tuitionReceipts.id })
          .from(tuitionReceipts)
          .where(inArray(tuitionReceipts.enrollmentId, enrollmentIds))
          .limit(1);
        if (receipt) throw new AppError("CONFLICT", "Học viên đã có phiếu thu học phí nên không xóa được. Hãy đổi trạng thái thành “Đã nghỉ”.");
      }

      const removed = await tx.delete(attendances).where(eq(attendances.studentId, id)).returning({ id: attendances.id });
      const deletedStarLogs = await purgeAllStudentStarLogs(tx, actor, id);
      await tx.delete(sessionStudents).where(eq(sessionStudents.studentId, id));
      await tx.delete(enrollments).where(eq(enrollments.studentId, id));
      // Lượt xếp học bù và lượt đổi quà của em tự xóa theo (ON DELETE CASCADE).
      await tx.delete(students).where(eq(students.id, id));
      const counts = { deletedEnrollments: enrollmentIds.length, deletedAttendances: removed.length, deletedStarLogs };
      await audit(tx, { userId: actor.userId, action: "delete", tableName: "students", recordId: id, oldValue: student, newValue: counts });
      return counts;
    });
  } catch (e) {
    throw translateDbError(e);
  }
}
