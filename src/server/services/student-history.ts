import { and, between, desc, eq, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { attendances, classes, courses, enrollments, makeupAssignments, rooms, sessionStudents, sessions, teachers } from "@/db/schema";
import { isAbsence, makeupState } from "@/domain/makeup";
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
      .select({ ...columns, absentDate: absentSession.date, absentClassCode: absentClass.code })
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
    ...own.filter((o) => !guestIds.has(o.sessionId)).map((o) => ({ ...o, makeup: false as const, absentDate: null, absentClassCode: null })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.classCode.localeCompare(b.classCode, "vi"));
}

/**
 * Lịch sử học của một học viên, để giáo viên biết em đã học gì và không dạy trùng chương trình:
 * - `programs`: từng lớp/khóa em đã và đang học, kèm số buổi có mặt trên số buổi lớp đã dạy trong thời gian em học.
 * - `sessions`: từng buổi đã điểm danh, kèm tên bài đã dạy.
 * Người xem được học viên thì xem được lịch sử ở MỌI lớp của em (chỉ ngày, lớp, tên bài, có mặt/vắng);
 * số sao của buổi chỉ có với lớp trong phạm vi của người xem.
 */
export async function getStudentLearningHistory(actor: Actor, studentId: string) {
  await assertStudentAccess(actor, studentId);
  const allowed = await allowedClassIds(actor);
  const inScope = (classId: string) => allowed === null || allowed.includes(classId);
  const attendedIn = sql`${attendances.status} in ('present', 'late', 'left_early')`;
  const [programs, history] = await Promise.all([
    db
      .select({
        enrollmentId: enrollments.id,
        classId: classes.id,
        classCode: classes.code,
        className: classes.name,
        courseName: courses.name,
        joinedAt: enrollments.joinedAt,
        leftAt: enrollments.leftAt,
        status: enrollments.status,
        classStatus: classes.status,
        // Buổi lớp đã dạy trong thời gian em học, và số buổi em có mặt trong các buổi đó.
        taught: sql<number>`(
          select count(*)::int from sessions s
          where s.class_id = ${classes.id} and s.status = 'done' and s.kind = 'regular'
            and s.date >= ${enrollments.joinedAt} and (${enrollments.leftAt} is null or s.date < ${enrollments.leftAt})
        )`,
        attended: sql<number>`(
          select count(*)::int from attendances a
          inner join sessions s on s.id = a.session_id
          where a.student_id = ${enrollments.studentId} and s.class_id = ${classes.id} and s.status = 'done' and s.kind = 'regular'
            and a.status in ('present', 'late', 'left_early')
            and s.date >= ${enrollments.joinedAt} and (${enrollments.leftAt} is null or s.date < ${enrollments.leftAt})
        )`,
      })
      .from(enrollments)
      .innerJoin(classes, eq(classes.id, enrollments.classId))
      .innerJoin(courses, eq(courses.id, classes.courseId))
      .where(eq(enrollments.studentId, studentId))
      .orderBy(desc(enrollments.joinedAt), desc(enrollments.createdAt)),
    db
      .select({
        sessionId: sessions.id,
        classId: classes.id,
        date: sessions.date,
        startTime: sessions.startTime,
        classCode: classes.code,
        courseName: courses.name,
        lesson: sessions.content,
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
      .innerJoin(courses, eq(courses.id, classes.courseId))
      .leftJoin(guestOf, and(eq(guestOf.makeupSessionId, sessions.id), eq(guestOf.studentId, attendances.studentId)))
      .leftJoin(madeUpIn, and(eq(madeUpIn.absentSessionId, sessions.id), eq(madeUpIn.studentId, attendances.studentId)))
      .leftJoin(makeupSession, eq(makeupSession.id, madeUpIn.makeupSessionId))
      .leftJoin(makeupAttendance, and(eq(makeupAttendance.sessionId, makeupSession.id), eq(makeupAttendance.studentId, attendances.studentId)))
      .where(and(eq(attendances.studentId, studentId), ne(sessions.status, "cancelled")))
      .orderBy(desc(sessions.date), desc(sessions.startTime))
      .limit(300),
  ]);
  return {
    programs,
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
