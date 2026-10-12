import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { attendances, classes, enrollments, sessions, starLogs } from "@/db/schema";
import { addDays, startOfWeek } from "@/lib/dates";
import { formatDateTime, formatTime, todayIso } from "@/lib/format";
import { forbidden, notFound } from "../errors";
import { type Actor, allowedClassIds, assertCan, can } from "../guard";
import { getAttendanceSheet, sessionRoster } from "./attendance";
import { getSession, listSessions } from "./sessions";
import { getSessionStarBoard, getStudentStarProfile, starTotalsOf } from "./stars";
import { listStudentsPage } from "./students";

// Chi tiết của dashboard 3D (trang Tổng quan), chỉ tải khi người dùng mở một buổi, một học viên hay một giáo viên.
// Mọi hàm chỉ ĐỌC và dùng lại các kiểm tra quyền sẵn có (quyền của menu, phạm vi lớp, chống IDOR). Không hàm nào trả
// thông tin cá nhân của học viên (ngày sinh, giới tính, phụ huynh, điện thoại, ghi chú): chỉ mã, họ tên, điểm danh và sao.

type AttendanceStatus = (typeof attendances.$inferSelect)["status"];
const ATTENDED: AttendanceStatus[] = ["present", "late", "left_early"];

const earliest = (dates: (Date | null)[]) => dates.reduce<Date | null>((min, d) => (d && (!min || d < min) ? d : min), null);

/**
 * Chi tiết một buổi học: lớp, người dạy, giờ, sĩ số, tỉ lệ điểm danh và danh sách học viên của buổi.
 * Cần quyền xem Điểm danh và quyền trên buổi. Số sao chỉ có khi người xem có quyền xem Sao (không thì null).
 */
export async function sessionDetail(actor: Actor, sessionId: string) {
  assertCan(actor, "attendance", "view");
  // getSession kiểm tra quyền trên buổi (trả NOT_FOUND cho buổi ngoài phạm vi).
  const session = await getSession(actor, sessionId);
  // Lớp chỉ hiển thị trên Thời khóa biểu không có học viên, điểm danh hay sao.
  if (session.timetableOnly) throw notFound("buổi học");
  const seesStars = can(actor, "stars", "view");
  const [[core], roster, marks, logs] = await Promise.all([
    db.select({ createdAt: sessions.createdAt }).from(sessions).where(eq(sessions.id, sessionId)).limit(1),
    sessionRoster(db, session),
    db
      .select({ studentId: attendances.studentId, status: attendances.status, recordedAt: attendances.recordedAt })
      .from(attendances)
      .where(eq(attendances.sessionId, sessionId)),
    seesStars
      ? db.select({ studentId: starLogs.studentId, stars: starLogs.stars, recordedAt: starLogs.recordedAt }).from(starLogs).where(eq(starLogs.sessionId, sessionId))
      : Promise.resolve([]),
  ]);
  const totals = seesStars ? await starTotalsOf(db, roster.map((r) => r.studentId)) : null;
  const statusOf = new Map(marks.map((m) => [m.studentId, m.status]));
  const sessionStars = new Map<string, number>();
  for (const log of logs) sessionStars.set(log.studentId, (sessionStars.get(log.studentId) ?? 0) + log.stars);
  const attended = marks.filter((m) => ATTENDED.includes(m.status)).length;
  return {
    id: session.id,
    classId: session.classId,
    classCode: session.classCode,
    className: session.className,
    date: session.date,
    startTime: formatTime(session.startTime),
    endTime: formatTime(session.endTime),
    roomName: session.roomName,
    // Tên gọi ngắn của giáo viên được ưu tiên, như trên Thời khóa biểu và trên cảnh 3D.
    teacherName: session.substituteShortName || session.substituteName || session.teacherShortName || session.teacherName || null,
    /** Giáo viên chính khi buổi có người dạy thay. */
    replacedTeacherName: session.substituteTeacherId ? session.teacherShortName || session.teacherName : null,
    assistantName: session.assistantShortName || session.assistantName,
    cancelled: session.status === "cancelled",
    /** Số học viên trong danh sách của buổi (kể cả học bù). */
    enrolled: roster.length,
    recorded: marks.length > 0,
    /** Số lượt đã điểm danh và số lượt có đi học (có mặt, đi trễ, về sớm). */
    marked: marks.length,
    attended,
    /** Tỉ lệ có đi học (%) trên các lượt đã điểm danh; null khi chưa điểm danh. */
    rate: marks.length === 0 ? null : Math.round((attended / marks.length) * 1000) / 10,
    seesStars,
    students: roster.map((r) => ({
      studentId: r.studentId,
      code: r.code,
      fullName: r.fullName,
      makeup: r.makeup,
      status: statusOf.get(r.studentId) ?? null,
      sessionStars: seesStars ? (sessionStars.get(r.studentId) ?? 0) : null,
      total: totals ? (totals.get(r.studentId) ?? 0) : null,
    })),
    timeline: {
      scheduledAt: core ? formatDateTime(core.createdAt) : null,
      attendanceAt: formatDateTime(earliest(marks.map((m) => m.recordedAt))) || null,
      starsAt: formatDateTime(earliest(logs.map((l) => l.recordedAt))) || null,
    },
  };
}
export type CenterSessionDetail = Awaited<ReturnType<typeof sessionDetail>>;

/** Lớp đang mở mà học viên đang ghi danh, giới hạn trong phạm vi lớp của người xem. */
async function currentClassesOf(actor: Actor, studentIds: string[]) {
  const out = new Map<string, { id: string; name: string }[]>();
  if (studentIds.length === 0) return out;
  const allowed = await allowedClassIds(actor);
  if (allowed && allowed.length === 0) return out;
  const rows = await db
    .select({ studentId: enrollments.studentId, id: classes.id, name: classes.name })
    .from(enrollments)
    .innerJoin(classes, eq(classes.id, enrollments.classId))
    .where(
      and(
        inArray(enrollments.studentId, studentIds),
        eq(enrollments.status, "active"),
        eq(classes.status, "open"),
        allowed ? inArray(enrollments.classId, allowed) : undefined,
      ),
    )
    .orderBy(asc(classes.name));
  for (const row of rows) out.set(row.studentId, [...(out.get(row.studentId) ?? []), { id: row.id, name: row.name }]);
  return out;
}

const HISTORY_SHOWN = 20;

/**
 * Thẻ học viên: mã, họ tên, lớp đang học, tổng sao và các lượt điểm danh gần nhất. Cần quyền xem QL Học viên; quyền trên
 * học viên và phạm vi lớp do `getStudentStarProfile` kiểm tra. Số sao chỉ có khi người xem có quyền xem Sao.
 */
export async function studentDetail(actor: Actor, studentId: string) {
  assertCan(actor, "students", "view");
  const profile = await getStudentStarProfile(actor, studentId);
  const seesStars = can(actor, "stars", "view");
  const [totals, classesOf] = await Promise.all([seesStars ? starTotalsOf(db, [studentId]) : null, currentClassesOf(actor, [studentId])]);
  return {
    id: profile.student.id,
    code: profile.student.code,
    fullName: profile.student.fullName,
    classes: classesOf.get(studentId) ?? [],
    total: totals ? (totals.get(studentId) ?? 0) : null,
    attendance: profile.attendance.slice(0, HISTORY_SHOWN).map((a) => ({
      sessionId: a.sessionId,
      date: a.date,
      startTime: formatTime(a.startTime),
      classCode: a.classCode,
      status: a.status,
      stars: seesStars ? a.stars : null,
    })),
  };
}
export type CenterStudentDetail = Awaited<ReturnType<typeof studentDetail>>;

/**
 * Các buổi trong tuần này (Thứ Hai → Chủ nhật) mà một giáo viên đứng lớp, dạy thay hoặc trợ giảng, gom theo lớp.
 * Phạm vi do `listSessions` áp: người chỉ thấy lớp của mình chỉ nhận các buổi trong phạm vi của mình.
 */
export async function teacherWeek(actor: Actor, teacherId: string, now: Date = new Date()) {
  const from = startOfWeek(todayIso(now));
  const to = addDays(from, 6);
  const rows = await listSessions(actor, { from, to, teacherId });
  const byClass = new Map<string, { classId: string; classCode: string; className: string; sessions: ReturnType<typeof toWeekSession>[] }>();
  const toWeekSession = (s: (typeof rows)[number]) => ({
    id: s.id,
    date: s.date,
    startTime: formatTime(s.startTime),
    endTime: formatTime(s.endTime),
    roomName: s.roomName,
    status: s.status,
    role:
      s.substituteTeacherId === teacherId
        ? ("substitute" as const)
        : s.assistantTeacherId === teacherId
          ? ("assistant" as const)
          : s.substituteTeacherId
            ? ("replaced" as const)
            : ("main" as const),
  });
  for (const row of rows) {
    const group = byClass.get(row.classId) ?? { classId: row.classId, classCode: row.classCode, className: row.className, sessions: [] };
    group.sessions.push(toWeekSession(row));
    byClass.set(row.classId, group);
  }
  return { from, to, total: rows.length, classes: [...byClass.values()] };
}
export type CenterTeacherWeek = Awaited<ReturnType<typeof teacherWeek>>;

const SEARCH_SHOWN = 8;

/**
 * Tìm học viên theo tên hoặc mã cho ô tìm kiếm của dashboard. Cần quyền xem QL Học viên; phạm vi lớp do `listStudentsPage` áp.
 * Chỉ trả mã, họ tên và lớp đang học.
 */
export async function searchStudents(actor: Actor, query: string) {
  const page = await listStudentsPage(actor, query, 1);
  const rows = page.rows.slice(0, SEARCH_SHOWN);
  const classesOf = await currentClassesOf(actor, rows.map((r) => r.id));
  return rows.map((r) => ({ id: r.id, code: r.code, fullName: r.fullName, classes: classesOf.get(r.id) ?? [] }));
}
export type CenterStudentHit = Awaited<ReturnType<typeof searchStudents>>[number];

/**
 * Dữ liệu để điểm danh và ghi sao một buổi ngay trên dashboard: đúng bảng điểm danh và bảng ghi sao của hai trang hiện có
 * (`getAttendanceSheet`, `getSessionStarBoard`), phần nào người dùng không có quyền xem thì là null.
 */
export async function sessionWorkspace(actor: Actor, sessionId: string, now: Date = new Date()) {
  const seesAttendance = can(actor, "attendance", "view");
  const seesStars = can(actor, "stars", "view");
  if (!seesAttendance && !seesStars) throw forbidden();
  const session = await getSession(actor, sessionId);
  if (session.timetableOnly) throw notFound("buổi học");
  const [sheet, board] = await Promise.all([
    seesAttendance ? getAttendanceSheet(actor, sessionId, now) : null,
    seesStars ? getSessionStarBoard(actor, sessionId) : null,
  ]);
  return {
    session: {
      id: session.id,
      classCode: session.classCode,
      className: session.className,
      date: session.date,
      startTime: formatTime(session.startTime),
      endTime: formatTime(session.endTime),
      roomName: session.roomName,
      content: session.content ?? "",
    },
    attendance: sheet && {
      rows: sheet.rows,
      lessons: sheet.lessons,
      recorded: sheet.recorded,
      teacherRemark: sheet.teacherRemark,
      // Cùng các lý do như trang Điểm danh: buổi bị khóa, chưa đến ngày, đã hủy, hoặc chỉ có quyền xem.
      blockedReason:
        sheet.blockedReason ??
        (sheet.canSave ? null : sheet.recorded ? "Bạn chỉ có quyền xem điểm danh đã lưu, không có quyền sửa." : "Bạn không có quyền điểm danh buổi chưa điểm danh."),
    },
    stars: board && {
      blockedReason: session.status === "cancelled" ? "Buổi đã hủy nên không ghi sao được." : session.date > todayIso(now) ? "Chưa đến ngày học." : null,
      canAward: can(actor, "stars", "add"),
      maxDeduction: board.maxDeduction,
      criteria: board.criteria.map((c) => ({ id: c.id, name: c.name, stars: c.stars })),
      students: board.students.map((s) => ({ studentId: s.studentId, code: s.code, fullName: s.fullName, makeup: s.makeup, sessionStars: s.sessionStars, total: s.total })),
      logs: board.logs.map((l) => ({
        id: l.id,
        studentName: l.studentName,
        criteriaName: l.criteriaName,
        stars: l.stars,
        recordedAtLabel: formatDateTime(l.recordedAt),
        isReversal: l.isReversal,
        reversed: l.reversed,
      })),
    },
  };
}
export type CenterWorkspace = Awaited<ReturnType<typeof sessionWorkspace>>;
