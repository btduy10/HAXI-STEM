import { and, between, desc, eq, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { attendances, classes, courses, enrollments, makeupAssignments, rooms, sessionStudents, sessions, teachers } from "@/db/schema";
import { isAbsence, makeupState } from "@/domain/makeup";
import { parseLessonLabel } from "@/domain/syllabus";
import { addDays } from "@/lib/dates";
import { todayIso } from "@/lib/format";
import { type Actor, allowedClassIds } from "../guard";
import { assertStudentAccess, starTotalsOf } from "./stars";
import { listStudentsPage } from "./students";

const madeUpIn = alias(makeupAssignments, "made_up_in");
const makeupSession = alias(sessions, "makeup_session");
const makeupAttendance = alias(attendances, "makeup_attendance");
const guestOf = alias(makeupAssignments, "guest_of");
const substituteTeacher = alias(teachers, "substitute");
const absentSession = alias(sessions, "absent_session");
const absentClass = alias(classes, "absent_class");

/** Lịch học trong hồ sơ học viên hiện các buổi từ hôm nay đến hết số ngày này (cùng khoảng với Xếp bù ở Ghi danh). */
export const STUDENT_SCHEDULE_DAYS = 28;

/**
 * Lịch học sắp tới của một học viên theo Thời khóa biểu, từ hôm nay đến hết `STUDENT_SCHEDULE_DAYS` ngày tới:
 * - buổi chưa dạy của các lớp đang mở mà em có ghi danh hiệu lực vào ngày đó (buổi bù riêng của lớp chỉ tính khi em được chọn);
 * - buổi học bù đã xếp ở Ghi danh (học ghép vào buổi của lớp khác), kèm buổi vắng được bù.
 * Như lịch sử buổi học, người xem được học viên thì thấy lịch ở MỌI lớp của em (chỉ ngày, giờ, lớp, giáo viên, phòng).
 */
export async function getStudentSchedule(actor: Actor, studentId: string, today: string = todayIso()) {
  await assertStudentAccess(actor, studentId);
  const upcoming = and(eq(sessions.status, "planned"), eq(classes.status, "open"), between(sessions.date, today, addDays(today, STUDENT_SCHEDULE_DAYS)));
  const columns = {
    sessionId: sessions.id,
    date: sessions.date,
    startTime: sessions.startTime,
    endTime: sessions.endTime,
    kind: sessions.kind,
    classCode: classes.code,
    className: classes.name,
    // Người thực dạy: giáo viên dạy thay nếu có; tên viết tắt nếu có.
    teacherName: sql<string | null>`coalesce(nullif(${substituteTeacher.shortName}, ''), ${substituteTeacher.fullName}, nullif(${teachers.shortName}, ''), ${teachers.fullName})`,
    roomName: rooms.name,
  };
  const enrolledOnDate = sql`exists (
    select 1 from ${enrollments}
    where ${enrollments.classId} = ${sessions.classId} and ${enrollments.studentId} = ${studentId}
      and ${sessions.date} >= ${enrollments.joinedAt} and (${enrollments.leftAt} is null or ${sessions.date} < ${enrollments.leftAt})
  )`;
  const pickedForMakeup = sql`exists (
    select 1 from ${sessionStudents} where ${sessionStudents.sessionId} = ${sessions.id} and ${sessionStudents.studentId} = ${studentId}
  )`;
  const [own, guest] = await Promise.all([
    db
      .select(columns)
      .from(sessions)
      .innerJoin(classes, eq(classes.id, sessions.classId))
      .leftJoin(teachers, eq(teachers.id, sessions.teacherId))
      .leftJoin(substituteTeacher, eq(substituteTeacher.id, sessions.substituteTeacherId))
      .leftJoin(rooms, eq(rooms.id, sessions.roomId))
      .where(and(upcoming, or(and(eq(sessions.kind, "regular"), enrolledOnDate), and(eq(sessions.kind, "makeup"), pickedForMakeup)))),
    db
      .select({ ...columns, absentDate: absentSession.date, absentClassCode: absentClass.code, absentClassName: absentClass.name })
      .from(makeupAssignments)
      .innerJoin(sessions, eq(sessions.id, makeupAssignments.makeupSessionId))
      .innerJoin(classes, eq(classes.id, sessions.classId))
      .innerJoin(absentSession, eq(absentSession.id, makeupAssignments.absentSessionId))
      .innerJoin(absentClass, eq(absentClass.id, absentSession.classId))
      .leftJoin(teachers, eq(teachers.id, sessions.teacherId))
      .leftJoin(substituteTeacher, eq(substituteTeacher.id, sessions.substituteTeacherId))
      .leftJoin(rooms, eq(rooms.id, sessions.roomId))
      .where(and(eq(makeupAssignments.studentId, studentId), upcoming)),
  ]);
  const guestIds = new Set(guest.map((g) => g.sessionId));
  return [
    // `makeup`: em học buổi này để bù một buổi vắng (học ghép); khi đó có ngày và lớp của buổi vắng.
    ...guest.map((g) => ({ ...g, makeup: true as const })),
    ...own.filter((o) => !guestIds.has(o.sessionId)).map((o) => ({ ...o, makeup: false as const, absentDate: null, absentClassCode: null, absentClassName: null })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.classCode.localeCompare(b.classCode, "vi"));
}

/**
 * Lịch sử học của một học viên, để giáo viên biết em đã học gì và không dạy trùng chương trình:
 * - `lessons`: các bài em đã học xong (buổi em có mặt và giáo viên đã ghi nội dung). Bài chọn từ Syllabus có tên khóa:
 *   một bài của một khóa chỉ một dòng dù em học ở lớp nào (kể cả buổi học bù).
 * - `courses`: mỗi khóa em đã học kèm số buổi đã học trên tổng số buổi của khóa. Đã học = số buổi khác nhau của khóa đó
 *   mà em có mặt, tính theo bài giáo viên chọn từ Syllabus khi điểm danh; nội dung tự gõ và nhãn cũ không kèm tên khóa
 *   không thuộc khóa nào. Lớp không gắn với khóa (một lớp học nhiều khóa) nên không đếm theo lớp.
 * - `sessions`: từng buổi đã điểm danh.
 * Người xem được học viên thì xem được lịch sử ở MỌI lớp của em (chỉ ngày, lớp, giáo viên, tên bài, có mặt/vắng);
 * số sao của buổi chỉ có với lớp trong phạm vi của người xem.
 */
export async function getStudentLearningHistory(actor: Actor, studentId: string) {
  await assertStudentAccess(actor, studentId);
  const allowed = await allowedClassIds(actor);
  const inScope = (classId: string) => allowed === null || allowed.includes(classId);
  const attendedIn = sql`${attendances.status} in ('present', 'late', 'left_early')`;
  const [allCourses, history] = await Promise.all([
    db.select({ name: courses.name, totalSessions: courses.totalSessions }).from(courses),
    db
      .select({
        sessionId: sessions.id,
        classId: classes.id,
        date: sessions.date,
        startTime: sessions.startTime,
        classCode: classes.code,
        className: classes.name,
        // Người thực dạy: giáo viên dạy thay nếu có; tên viết tắt nếu có.
        teacherName: sql<string | null>`coalesce(nullif(${substituteTeacher.shortName}, ''), ${substituteTeacher.fullName}, nullif(${teachers.shortName}, ''), ${teachers.fullName})`,
        content: sessions.content,
        status: attendances.status,
        // Em học buổi này với tư cách học bù (học ghép từ lớp khác).
        isMakeup: sql<boolean>`${guestOf.id} is not null`,
        makeupAssigned: sql<boolean>`${madeUpIn.id} is not null`,
        makeupDate: makeupSession.date,
        makeupSessionStatus: makeupSession.status,
        makeupAttendance: makeupAttendance.status,
        stars: sql<number>`coalesce((select sum(l.stars) from star_logs l where l.session_id = ${sessions.id} and l.student_id = ${attendances.studentId}), 0)::int`,
        attended: sql<boolean>`${attendedIn}`,
      })
      .from(attendances)
      .innerJoin(sessions, eq(sessions.id, attendances.sessionId))
      .innerJoin(classes, eq(classes.id, sessions.classId))
      .leftJoin(teachers, eq(teachers.id, sessions.teacherId))
      .leftJoin(substituteTeacher, eq(substituteTeacher.id, sessions.substituteTeacherId))
      .leftJoin(guestOf, and(eq(guestOf.makeupSessionId, sessions.id), eq(guestOf.studentId, attendances.studentId)))
      .leftJoin(madeUpIn, and(eq(madeUpIn.absentSessionId, sessions.id), eq(madeUpIn.studentId, attendances.studentId)))
      .leftJoin(makeupSession, eq(makeupSession.id, madeUpIn.makeupSessionId))
      .leftJoin(makeupAttendance, and(eq(makeupAttendance.sessionId, makeupSession.id), eq(makeupAttendance.studentId, attendances.studentId)))
      .where(and(eq(attendances.studentId, studentId), ne(sessions.status, "cancelled")))
      .orderBy(desc(sessions.date), desc(sessions.startTime))
      .limit(300),
  ]);

  // Bài đã học: buổi em có mặt và đã ghi nội dung; lấy lần học đầu tiên của mỗi bài.
  const normalize = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();
  const firstLearned = new Map<string, { row: (typeof history)[number]; content: string; lesson: ReturnType<typeof parseLessonLabel> }>();
  for (const row of [...history].reverse()) {
    const content = row.content?.trim();
    if (!row.attended || !content) continue;
    // `lesson`: bài chọn từ Syllabus (có số buổi, và tên khóa nếu là nhãn mới); null khi giáo viên tự gõ nội dung.
    const lesson = parseLessonLabel(content);
    const key = lesson?.courseName ? `course|${normalize(lesson.courseName)}|${lesson.period}` : `class|${row.classId}|${content}`;
    if (!firstLearned.has(key)) firstLearned.set(key, { row, content, lesson });
  }
  const lessons = [...firstLearned.values()]
    .map(({ row, content, lesson }) => ({
      sessionId: row.sessionId,
      classCode: row.classCode,
      className: row.className,
      date: row.date,
      isMakeup: row.isMakeup,
      content,
      lesson,
    }))
    // Bài có tên khóa đứng trước, theo khóa rồi theo buổi; còn lại theo lớp, số buổi, ngày học.
    .sort(
      (a, b) =>
        Number(!a.lesson?.courseName) - Number(!b.lesson?.courseName) ||
        (a.lesson?.courseName ?? "").localeCompare(b.lesson?.courseName ?? "", "vi") ||
        (a.lesson?.courseName ? 0 : a.className.localeCompare(b.className, "vi")) ||
        (a.lesson?.period ?? Number.MAX_SAFE_INTEGER) - (b.lesson?.period ?? Number.MAX_SAFE_INTEGER) ||
        a.date.localeCompare(b.date),
    );

  // Số buổi đã học của từng khóa: mỗi (khóa, buổi) đã có đúng một dòng ở trên.
  const courseOf = new Map(allCourses.map((c) => [normalize(c.name), c]));
  const learnedOf = new Map<string, { courseName: string; learned: number }>();
  for (const { lesson } of lessons) {
    if (!lesson?.courseName) continue;
    const key = normalize(lesson.courseName);
    const entry = learnedOf.get(key) ?? { courseName: courseOf.get(key)?.name ?? lesson.courseName, learned: 0 };
    entry.learned++;
    learnedOf.set(key, entry);
  }
  const progress = [...learnedOf.entries()]
    // `totalSessions` null: khóa đã đổi tên hoặc đã xóa nên không còn biết tổng số buổi.
    .map(([key, entry]) => ({ ...entry, totalSessions: courseOf.get(key)?.totalSessions ?? null }))
    .sort((a, b) => a.courseName.localeCompare(b.courseName, "vi"));

  return {
    courses: progress,
    lessons,
    sessions: history.map(({ classId, makeupAssigned, makeupSessionStatus, makeupAttendance: madeUp, stars, ...row }) => ({
      ...row,
      // Sao của buổi chỉ hiện với lớp trong phạm vi của người xem.
      stars: inScope(classId) ? stars : null,
      // Buổi vắng: đã xếp bù / đã bù hay chưa.
      makeup: isAbsence(row.status) ? makeupState(makeupAssigned && makeupSessionStatus ? { sessionStatus: makeupSessionStatus, attendance: madeUp } : null) : null,
    })),
  };
}

/** Danh sách học viên theo trang kèm tổng sao tích lũy của từng em. */
export async function listStudentsPageWithStars(actor: Actor, search: string | undefined, page: number) {
  const result = await listStudentsPage(actor, search, page);
  const totals = await starTotalsOf(db, result.rows.map((s) => s.id));
  return { ...result, rows: result.rows.map((s) => ({ ...s, stars: totals.get(s.id) ?? 0 })) };
}
