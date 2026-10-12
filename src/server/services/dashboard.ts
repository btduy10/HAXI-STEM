import { and, between, count, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { attendances, classes, enrollments, sessions, starLogs, students, teachers } from "@/db/schema";
import type { CenterData } from "@/domain/center-3d";
import { addDays, startOfWeek } from "@/lib/dates";
import { formatTime, timeNow, todayIso } from "@/lib/format";
import { type Actor, allowedClassIds, assertAdmin, can } from "../guard";
import { listRooms } from "./catalog";
import { type SessionRow, listSessions } from "./sessions";

export async function adminOverview(actor: Actor) {
  assertAdmin(actor);
  const [[s], [t], [c]] = await Promise.all([
    db.select({ n: count() }).from(students).where(eq(students.status, "active")),
    db.select({ n: count() }).from(teachers).where(eq(teachers.status, "active")),
    db.select({ n: count() }).from(classes).where(and(eq(classes.status, "open"), eq(classes.timetableOnly, false))),
  ]);
  return { activeStudents: s?.n ?? 0, activeTeachers: t?.n ?? 0, openClasses: c?.n ?? 0 };
}

export type AttendanceBreakdown = { present: number; late: number; left_early: number; excused: number; absent: number };
const EMPTY_BREAKDOWN: AttendanceBreakdown = { present: 0, late: 0, left_early: 0, excused: 0, absent: 0 };

export type DashboardCharts = {
  /** Số lượt điểm danh theo trạng thái trong 30 ngày qua. */
  attendance: AttendanceBreakdown;
  /** Tỷ lệ có đi học (có mặt + trễ + về sớm) trên các lượt điểm danh, theo từng lớp đang mở. */
  classRates: { classId: string; code: string; name: string; rate: number; total: number }[];
  /** Tổng sao ghi nhận (thưởng trừ phạt) theo tuần, 8 tuần gần nhất, cũ → mới. */
  starsByWeek: { weekStart: string; stars: number }[];
};

const WEEKS = 8;

/** Số liệu biểu đồ trang Tổng quan. Admin: toàn trung tâm; GV: chỉ các lớp được phân công. */
export async function dashboardCharts(actor: Actor, now: Date = new Date()): Promise<DashboardCharts> {
  const allowed = await allowedClassIds(actor);
  const today = todayIso(now);
  const firstWeek = addDays(startOfWeek(today), -7 * (WEEKS - 1));
  const weeks = Array.from({ length: WEEKS }, (_, i) => addDays(firstWeek, i * 7));
  if (allowed && allowed.length === 0) {
    return { attendance: EMPTY_BREAKDOWN, classRates: [], starsByWeek: weeks.map((weekStart) => ({ weekStart, stars: 0 })) };
  }
  const inScope = allowed ? inArray(sessions.classId, allowed) : undefined;
  const since = addDays(today, -30);
  const attended = sql<number>`count(*) filter (where ${attendances.status} in ('present', 'late', 'left_early'))::int`;

  const [statusRows, rateRows, starRows] = await Promise.all([
    db
      .select({ status: attendances.status, n: count() })
      .from(attendances)
      .innerJoin(sessions, eq(sessions.id, attendances.sessionId))
      .where(and(gte(sessions.date, since), eq(sessions.status, "done"), inScope))
      .groupBy(attendances.status),
    db
      .select({ classId: classes.id, code: classes.code, name: classes.name, attended, total: sql<number>`count(*)::int` })
      .from(attendances)
      .innerJoin(sessions, eq(sessions.id, attendances.sessionId))
      .innerJoin(classes, eq(classes.id, sessions.classId))
      .where(and(eq(sessions.status, "done"), eq(classes.status, "open"), inScope))
      .groupBy(classes.id, classes.code, classes.name)
      .orderBy(classes.code),
    // Gom theo tuần của NGÀY HỌC (buổi học), không theo lúc bấm ghi.
    db
      .select({
        weekStart: sql<string>`to_char(date_trunc('week', ${sessions.date}), 'YYYY-MM-DD')`,
        stars: sql<number>`coalesce(sum(${starLogs.stars}), 0)::int`,
      })
      .from(starLogs)
      .innerJoin(sessions, eq(sessions.id, starLogs.sessionId))
      .where(and(gte(sessions.date, firstWeek), inScope))
      .groupBy(sql`date_trunc('week', ${sessions.date})`),
  ]);

  const attendance = { ...EMPTY_BREAKDOWN };
  for (const row of statusRows) attendance[row.status] = row.n;

  const starsOf = new Map(starRows.map((r) => [r.weekStart, r.stars]));

  return {
    attendance,
    classRates: rateRows.map((r) => ({
      classId: r.classId,
      code: r.code,
      name: r.name,
      total: r.total,
      rate: r.total === 0 ? 0 : Math.round((r.attended / r.total) * 1000) / 10,
    })),
    starsByWeek: weeks.map((weekStart) => ({ weekStart, stars: starsOf.get(weekStart) ?? 0 })),
  };
}

/**
 * Dữ liệu của giao diện 3D trung tâm ở trang Tổng quan: mọi phòng và các buổi hôm nay trong phạm vi của người dùng
 * (phạm vi do `listSessions` áp). Chỉ gồm tên lớp, người thực dạy, giờ, trạng thái hủy, sĩ số và số lượt đã điểm danh / đã ghi sao;
 * không có tên hay thông tin nào của học viên (chi tiết học viên chỉ tải khi người dùng mở một buổi, xem `center-detail.ts`). `hrefOf`: trang mở buổi học, null nếu buổi không bấm vào được.
 */
export async function centerToday(actor: Actor, hrefOf: (session: SessionRow) => string | null, now: Date = new Date()): Promise<CenterData> {
  const today = todayIso(now);
  const [roomRows, sessionRows] = await Promise.all([
    listRooms(actor),
    listSessions(actor, { from: today, to: today, includeTimetableOnly: true }),
  ]);
  // Sĩ số: số học viên đang ghi danh của lớp. Lớp chỉ hiển thị trên Thời khóa biểu không có học viên.
  const classIds = [...new Set(sessionRows.filter((s) => !s.timetableOnly).map((s) => s.classId))];
  const counts =
    classIds.length === 0
      ? []
      : await db
          .select({ classId: enrollments.classId, n: count() })
          .from(enrollments)
          .where(and(inArray(enrollments.classId, classIds), eq(enrollments.status, "active")))
          .groupBy(enrollments.classId);
  const countOf = new Map(counts.map((c) => [c.classId, c.n]));
  const seesStars = can(actor, "stars", "view");
  return {
    today,
    now: timeNow(now),
    rooms: roomRows.map((r) => ({ id: r.id, name: r.name, capacity: r.capacity })),
    sessions: sessionRows.map((s) => ({
      id: s.id,
      classId: s.classId,
      roomId: s.roomId,
      className: s.className,
      teacherId: s.substituteTeacherId ?? s.teacherId,
      teacherName: s.substituteShortName || s.substituteName || s.teacherShortName || s.teacherName || null,
      startTime: formatTime(s.startTime),
      endTime: formatTime(s.endTime),
      cancelled: s.status === "cancelled",
      timetableOnly: s.timetableOnly,
      studentCount: s.timetableOnly ? null : (countOf.get(s.classId) ?? 0),
      attendanceCount: s.attendanceCount,
      starLogCount: seesStars ? s.starLogCount : 0,
      href: hrefOf(s),
    })),
  };
}

export type CenterKpis = {
  /** Số học viên có buổi học hôm nay, và của cùng thứ tuần trước. */
  studentsToday: { value: number; previous: number };
  /** Tỉ lệ có đi học (%) trên các lượt đã điểm danh từ đầu tuần đến hôm nay, và của cùng khoảng ngày tuần trước; null = chưa có lượt nào. */
  attendanceRate: { value: number | null; previous: number | null };
  /** Tổng sao (thưởng trừ phạt) theo ngày học từ đầu tuần đến hôm nay, và của cùng khoảng ngày tuần trước. */
  starsWeek: { value: number; previous: number };
};

/**
 * Ba số liệu chính của dashboard kèm số của kỳ trước để so sánh. Admin và phạm vi "Tất cả lớp": toàn trung tâm;
 * phạm vi "lớp của mình": chỉ các lớp trong phạm vi (cùng cách lọc với `dashboardCharts`). Chỉ là số đếm, không có dữ liệu học viên.
 */
export async function centerKpis(actor: Actor, now: Date = new Date()): Promise<CenterKpis> {
  const allowed = await allowedClassIds(actor);
  if (allowed && allowed.length === 0) {
    return { studentsToday: { value: 0, previous: 0 }, attendanceRate: { value: null, previous: null }, starsWeek: { value: 0, previous: 0 } };
  }
  const inScope = allowed ? inArray(sessions.classId, allowed) : undefined;
  const today = todayIso(now);
  const weekStart = startOfWeek(today);

  // Học viên có ghi danh hiệu lực tại ngày học ở một lớp có buổi chưa hủy trong ngày đó (mỗi em tính một lần).
  const studentsOn = async (date: string) => {
    const [row] = await db
      .select({ n: sql<number>`count(distinct ${enrollments.studentId})::int` })
      .from(sessions)
      .innerJoin(classes, eq(classes.id, sessions.classId))
      .innerJoin(enrollments, eq(enrollments.classId, sessions.classId))
      .where(
        and(
          eq(sessions.date, date),
          ne(sessions.status, "cancelled"),
          eq(classes.timetableOnly, false),
          lte(enrollments.joinedAt, date),
          or(isNull(enrollments.leftAt), gt(enrollments.leftAt, date)),
          inScope,
        ),
      );
    return row?.n ?? 0;
  };
  const rateBetween = async (from: string, to: string) => {
    const [row] = await db
      .select({
        attended: sql<number>`count(*) filter (where ${attendances.status} in ('present', 'late', 'left_early'))::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(attendances)
      .innerJoin(sessions, eq(sessions.id, attendances.sessionId))
      .where(and(between(sessions.date, from, to), eq(sessions.status, "done"), inScope));
    return !row || row.total === 0 ? null : Math.round((row.attended / row.total) * 1000) / 10;
  };
  const starsBetween = async (from: string, to: string) => {
    const [row] = await db
      .select({ stars: sql<number>`coalesce(sum(${starLogs.stars}), 0)::int` })
      .from(starLogs)
      .innerJoin(sessions, eq(sessions.id, starLogs.sessionId))
      .where(and(between(sessions.date, from, to), inScope));
    return row?.stars ?? 0;
  };

  const [studentsNow, studentsBefore, rateNow, rateBefore, starsNow, starsBefore] = await Promise.all([
    studentsOn(today),
    studentsOn(addDays(today, -7)),
    rateBetween(weekStart, today),
    rateBetween(addDays(weekStart, -7), addDays(today, -7)),
    starsBetween(weekStart, today),
    starsBetween(addDays(weekStart, -7), addDays(today, -7)),
  ]);
  return {
    studentsToday: { value: studentsNow, previous: studentsBefore },
    attendanceRate: { value: rateNow, previous: rateBefore },
    starsWeek: { value: starsNow, previous: starsBefore },
  };
}
