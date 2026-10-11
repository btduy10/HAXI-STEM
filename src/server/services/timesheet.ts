import { and, between, eq, inArray, ne, or } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/db";
import { classes, rooms, sessions, teacherRates, teachers, timeSlots, timesheetEntries, timesheetOverrides } from "@/db/schema";
import { WEEKDAY_NAMES, isoWeekday } from "@/lib/dates";
import { formatDate, formatTime, todayIso } from "@/lib/format";
import { SLOT_NAME_LABELS, type timesheetAdjustInput, type timesheetEntryInput } from "@/lib/validation/entities";
import { audit } from "../audit";
import { AppError, notFound, translateDbError } from "../errors";
import type { ExportDoc } from "../export";
import { type Actor, assertCan, assertNotTimetableOnly, seesAllClasses } from "../guard";
import { createRow, deleteRow, updateRow } from "./crud";

export type TimesheetFilters = {
  from: string;
  to: string;
  teacherId?: string | null;
  classId?: string | null;
};

/** taught = đã dạy (đã điểm danh) → được tính công; pending = đã qua ngày nhưng chưa điểm danh; upcoming = chưa tới ngày. */
export type TimesheetState = "taught" | "pending" | "upcoming";
/** Vai trò của người được tính công ở một buổi. */
export type TimesheetRole = "main" | "substitute" | "assistant";
/** Dòng công của một buổi học: lead = người thực dạy, assistant = trợ giảng. */
export type TimesheetPart = "lead" | "assistant";

export const TIMESHEET_ROLE_LABEL: Record<TimesheetRole, string> = { main: "Dạy chính", substitute: "Dạy thay", assistant: "Trợ giảng" };

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

export type TimesheetSummary = {
  teacherId: string;
  teacherCode: string;
  teacherName: string;
  /** Số công đứng lớp chính (gồm dạy thay). */
  taught: number;
  substitute: number;
  /** Số công trợ giảng. */
  assistant: number;
  minutes: number;
  pending: number;
  upcoming: number;
  /** Các mức lương/buổi đang áp dụng cho các công đã dạy (mỗi lớp một mức), từ nhỏ tới lớn. */
  rates: number[];
  /** Thành tiền = tổng mức lương của các công đã dạy có mức lương. */
  amount: number;
  /** Số công đã dạy ở lớp chưa đặt mức lương (không cộng vào thành tiền). */
  missingRate: number;
};

type LoadFilters = { from: string; to: string; teacherId?: string | null; classId?: string | null };

/**
 * Mọi dòng công trong khoảng ngày, gộp từ ba nguồn:
 * - buổi học chưa hủy: một dòng cho người THỰC DẠY (GV dạy thay nếu có, không thì GV của buổi) và một dòng cho trợ giảng;
 * - phần sửa của các dòng đó (`timesheet_overrides`): đổi Ngày / Ca – Khung giờ / Lớp chỉ trên bảng công;
 * - công bổ sung ghi tay (`timesheet_entries`), luôn được tính là một công.
 * Lọc khoảng ngày và lớp theo giá trị SAU khi sửa. Mức lương lấy theo Giáo viên + Lớp của dòng công (sau khi sửa).
 */
async function loadRows(filters: LoadFilters, today: string) {
  const { teacherId, classId } = filters;
  const inRange = (date: string) => date >= filters.from && date <= filters.to;

  // Buổi có phần sửa rơi vào khoảng ngày đang xem cũng phải lấy, dù ngày gốc của buổi nằm ngoài.
  const movedIn = await db
    .select({ sessionId: timesheetOverrides.sessionId })
    .from(timesheetOverrides)
    .where(between(timesheetOverrides.date, filters.from, filters.to));
  const movedIds = [...new Set(movedIn.map((o) => o.sessionId))];
  const moved = movedIds.length ? inArray(sessions.id, movedIds) : undefined;

  // Buổi của lớp chỉ hiển thị trên Thời khóa biểu không tính công.
  const conditions = [ne(sessions.status, "cancelled"), eq(classes.timetableOnly, false), or(between(sessions.date, filters.from, filters.to), moved)!];
  if (classId) conditions.push(or(eq(sessions.classId, classId), moved)!);
  if (teacherId) {
    conditions.push(
      or(eq(sessions.teacherId, teacherId), eq(sessions.substituteTeacherId, teacherId), eq(sessions.assistantTeacherId, teacherId))!,
    );
  }
  const entryConditions = [between(timesheetEntries.date, filters.from, filters.to)];
  if (classId) entryConditions.push(eq(timesheetEntries.classId, classId));
  if (teacherId) entryConditions.push(eq(timesheetEntries.teacherId, teacherId));

  const [found, entries, slotRows] = await Promise.all([
    db
      .select({
        id: sessions.id,
        classId: sessions.classId,
        date: sessions.date,
        timeSlotId: sessions.timeSlotId,
        startTime: sessions.startTime,
        endTime: sessions.endTime,
        status: sessions.status,
        kind: sessions.kind,
        teacherId: sessions.teacherId,
        substituteTeacherId: sessions.substituteTeacherId,
        assistantTeacherId: sessions.assistantTeacherId,
        roomName: rooms.name,
      })
      .from(sessions)
      .innerJoin(classes, eq(classes.id, sessions.classId))
      .leftJoin(rooms, eq(rooms.id, sessions.roomId))
      .where(and(...conditions)),
    db.select().from(timesheetEntries).where(and(...entryConditions)),
    db.select().from(timeSlots),
  ]);
  const overrides = found.length
    ? await db
        .select()
        .from(timesheetOverrides)
        .where(inArray(timesheetOverrides.sessionId, found.map((s) => s.id)))
    : [];
  const overrideOf = new Map(overrides.map((o) => [`${o.sessionId}|${o.part}`, o]));
  const slotOf = new Map(slotRows.map((s) => [s.id, s]));

  const fromSessions = found.flatMap((s) => {
    const lead = s.substituteTeacherId ?? s.teacherId;
    const people: { teacherId: string; role: TimesheetRole; part: TimesheetPart }[] = [];
    if (lead) people.push({ teacherId: lead, role: s.substituteTeacherId ? "substitute" : "main", part: "lead" });
    if (s.assistantTeacherId && s.assistantTeacherId !== lead) people.push({ teacherId: s.assistantTeacherId, role: "assistant", part: "assistant" });
    return people.map((p) => {
      const o = overrideOf.get(`${s.id}|${p.part}`);
      const timeSlotId = o?.timeSlotId ?? s.timeSlotId;
      // Đổi sang khung giờ khác thì lấy giờ của khung đó; còn lại giữ giờ thực của buổi.
      const slot = timeSlotId && timeSlotId !== s.timeSlotId ? slotOf.get(timeSlotId) : undefined;
      const effClassId = o?.classId ?? s.classId;
      return {
        ...p,
        key: `${s.id}|${p.part}`,
        id: s.id,
        source: "session" as "session" | "manual",
        edited: Boolean(o),
        note: o?.note ?? null,
        classId: effClassId,
        date: o?.date ?? s.date,
        timeSlotId,
        startTime: slot?.defaultStart ?? s.startTime,
        endTime: slot?.defaultEnd ?? s.endTime,
        status: s.status,
        kind: s.kind,
        // Phòng là của buổi gốc; đã đổi lớp thì không còn đúng nên để trống.
        roomName: effClassId === s.classId ? s.roomName : null,
      };
    });
  });
  const fromEntries = entries.map((e) => {
    const slot = slotOf.get(e.timeSlotId);
    return {
      teacherId: e.teacherId,
      role: e.role as TimesheetRole,
      part: null as TimesheetPart | null,
      key: `manual|${e.id}`,
      id: e.id,
      source: "manual" as "session" | "manual",
      edited: false,
      note: e.note,
      classId: e.classId,
      date: e.date,
      timeSlotId: e.timeSlotId as string | null,
      startTime: slot?.defaultStart ?? "00:00",
      endTime: slot?.defaultEnd ?? "00:00",
      status: "done" as (typeof found)[number]["status"],
      kind: "regular" as (typeof found)[number]["kind"],
      roomName: null as string | null,
    };
  });
  const all = [...fromSessions, ...fromEntries].filter(
    (r) => inRange(r.date) && (!classId || r.classId === classId) && (!teacherId || r.teacherId === teacherId),
  );

  const teacherIds = [...new Set(all.map((r) => r.teacherId))];
  const classIds = [...new Set(all.map((r) => r.classId))];
  const [teacherRows, rateRows, classRows] = await Promise.all([
    teacherIds.length ? db.select({ id: teachers.id, code: teachers.code, fullName: teachers.fullName }).from(teachers).where(inArray(teachers.id, teacherIds)) : [],
    teacherIds.length
      ? db
          .select({ teacherId: teacherRates.teacherId, classId: teacherRates.classId, rate: teacherRates.rate })
          .from(teacherRates)
          .where(and(inArray(teacherRates.teacherId, teacherIds), inArray(teacherRates.classId, classIds)))
      : [],
    classIds.length
      ? db
          .select({ id: classes.id, code: classes.code, name: classes.name })
          .from(classes)
          .where(inArray(classes.id, classIds))
      : [],
  ]);
  const teacherOf = new Map(teacherRows.map((t) => [t.id, t]));
  const classOf = new Map(classRows.map((c) => [c.id, c]));
  const rateOf = new Map(rateRows.map((r) => [`${r.teacherId}|${r.classId}`, r.rate]));
  const slotLabel = (id: string | null) => {
    const slot = id ? slotOf.get(id) : undefined;
    return slot ? `${(SLOT_NAME_LABELS as Record<string, string>)[slot.name] ?? slot.name} – Khung ${slot.frame}` : "";
  };

  return all
    .map((r) => {
      const state = (r.status === "done" ? "taught" : r.date <= today ? "pending" : "upcoming") as TimesheetState;
      const rate = rateOf.get(`${r.teacherId}|${r.classId}`) ?? null;
      return {
        ...r,
        teacherCode: teacherOf.get(r.teacherId)?.code ?? "",
        teacherName: teacherOf.get(r.teacherId)?.fullName ?? "",
        classCode: classOf.get(r.classId)?.code ?? "",
        className: classOf.get(r.classId)?.name ?? "",
        slotLabel: slotLabel(r.timeSlotId),
        isSubstitute: r.role === "substitute",
        minutes: Math.max(0, minutesOf(r.endTime) - minutesOf(r.startTime)),
        state,
        /** Mức lương/buổi của giáo viên ở lớp này; null = chưa đặt. */
        rate,
        /** Thành tiền của dòng: chỉ công đã dạy và có mức lương mới có tiền. */
        amount: state === "taught" ? rate : null,
      };
    })
    // Chi tiết buổi dạy: tăng dần theo ngày, cùng ngày thì giờ dạy trước ở trên.
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.teacherCode.localeCompare(b.teacherCode));
}

export type TimesheetRow = Awaited<ReturnType<typeof loadRows>>[number];

/**
 * Chấm công giáo viên: mỗi buổi đã điểm danh là một công cho người thực dạy và, nếu có, cho trợ giảng;
 * buổi đã hủy không tính; công bổ sung ghi tay luôn là một công.
 * Thành tiền = tổng mức lương/buổi (Mức lương giáo viên/Nhân viên, theo Giáo viên + Lớp) của các công đã dạy.
 * Phạm vi "lớp của mình": chỉ thấy công của chính mình.
 */
export async function teacherTimesheet(actor: Actor, filters: TimesheetFilters, now: Date = new Date()) {
  assertCan(actor, "timesheet", "view");
  const ownOnly = !seesAllClasses(actor);
  if (ownOnly && !actor.teacherId) return { rows: [] as TimesheetRow[], summary: [] as TimesheetSummary[] };
  const teacherId = ownOnly ? actor.teacherId : filters.teacherId;

  const rows = await loadRows({ ...filters, teacherId }, todayIso(now));
  return { rows, summary: summarize(rows) };
}

/**
 * Mọi dòng công trong khoảng ngày kèm tổng theo giáo viên, KHÔNG kiểm quyền Chấm công:
 * dùng cho Báo cáo (chi lương), hàm gọi phải tự kiểm quyền.
 */
export async function timesheetForReport(from: string, to: string, now: Date = new Date()) {
  const rows = await loadRows({ from, to }, todayIso(now));
  return { rows, summary: summarize(rows) };
}

function summarize(rows: TimesheetRow[]): TimesheetSummary[] {
  const byTeacher = new Map<string, TimesheetSummary>();
  for (const r of rows) {
    const item = byTeacher.get(r.teacherId) ?? {
      teacherId: r.teacherId,
      teacherCode: r.teacherCode,
      teacherName: r.teacherName,
      taught: 0,
      substitute: 0,
      assistant: 0,
      minutes: 0,
      pending: 0,
      upcoming: 0,
      rates: [],
      amount: 0,
      missingRate: 0,
    };
    if (r.state === "taught") {
      if (r.role === "assistant") item.assistant += 1;
      else item.taught += 1;
      if (r.role === "substitute") item.substitute += 1;
      item.minutes += r.minutes;
      if (r.rate === null) item.missingRate += 1;
      else {
        item.amount += r.rate;
        if (!item.rates.includes(r.rate)) item.rates = [...item.rates, r.rate].sort((a, b) => a - b);
      }
    } else {
      item[r.state] += 1;
    }
    byTeacher.set(r.teacherId, item);
  }
  // Tổng công xếp theo mã giáo viên (dòng công thì xếp theo ngày).
  return [...byTeacher.values()].sort((a, b) => a.teacherCode.localeCompare(b.teacherCode));
}

/** Phạm vi "lớp của mình": chỉ thao tác trên công của chính mình. NOT_FOUND để không lộ công của người khác. */
function assertOwnRow(actor: Actor, teacherId: string) {
  if (!seesAllClasses(actor) && actor.teacherId !== teacherId) throw notFound("dòng công");
}

/** Một giáo viên không có hai dòng công cùng Ngày + Ca + Khung giờ (cùng quy tắc với trùng lịch). */
async function assertSlotFree(teacherId: string, date: string, timeSlotId: string | null, exceptKey?: string) {
  if (!timeSlotId) return;
  const sameDay = await loadRows({ from: date, to: date, teacherId }, date);
  if (sameDay.some((r) => r.key !== exceptKey && r.timeSlotId === timeSlotId)) {
    throw new AppError("VALIDATION", "Giáo viên đã có công ở ngày, ca và khung giờ này.", {
      timeSlotId: "Giáo viên đã có công ở ngày, ca và khung giờ này.",
    });
  }
}

/** Chấm công bổ sung: thêm một dòng công ghi tay cho giáo viên. */
export async function createTimesheetEntry(actor: Actor, data: z.output<typeof timesheetEntryInput>) {
  assertCan(actor, "timesheet", "add");
  assertOwnRow(actor, data.teacherId);
  await assertNotTimetableOnly(data.classId);
  await assertSlotFree(data.teacherId, data.date, data.timeSlotId);
  return createRow(actor, timesheetEntries, "timesheet_entries", { ...data, createdBy: actor.userId }, "timesheet");
}

export async function updateTimesheetEntry(actor: Actor, id: string, data: z.output<typeof timesheetEntryInput>) {
  assertCan(actor, "timesheet", "edit");
  const [current] = await db.select({ teacherId: timesheetEntries.teacherId }).from(timesheetEntries).where(eq(timesheetEntries.id, id)).limit(1);
  if (!current) throw notFound("dòng công");
  assertOwnRow(actor, current.teacherId);
  assertOwnRow(actor, data.teacherId);
  await assertNotTimetableOnly(data.classId);
  await assertSlotFree(data.teacherId, data.date, data.timeSlotId, `manual|${id}`);
  return updateRow(actor, timesheetEntries, "timesheet_entries", id, data, "timesheet");
}

export const deleteTimesheetEntry = (actor: Actor, id: string) => deleteRow(actor, timesheetEntries, "timesheet_entries", id);

/**
 * Sửa một dòng công sinh từ buổi học: chỉ đổi Ngày / Ca – Khung giờ / Lớp trên bảng công, KHÔNG đổi buổi học
 * (Thời khóa biểu, điểm danh giữ nguyên). Sửa về đúng giá trị của buổi và không có ghi chú thì bỏ phần sửa.
 */
export async function adjustSessionTimesheet(actor: Actor, input: z.output<typeof timesheetAdjustInput>) {
  assertCan(actor, "timesheet", "edit");
  const [session] = await db
    .select({
      id: sessions.id,
      classId: sessions.classId,
      date: sessions.date,
      timeSlotId: sessions.timeSlotId,
      status: sessions.status,
      teacherId: sessions.teacherId,
      substituteTeacherId: sessions.substituteTeacherId,
      assistantTeacherId: sessions.assistantTeacherId,
    })
    .from(sessions)
    .where(eq(sessions.id, input.sessionId))
    .limit(1);
  if (!session || session.status === "cancelled") throw notFound("dòng công");
  const lead = session.substituteTeacherId ?? session.teacherId;
  const teacherId = input.part === "lead" ? lead : session.assistantTeacherId !== lead ? session.assistantTeacherId : null;
  if (!teacherId) throw notFound("dòng công");
  assertOwnRow(actor, teacherId);

  const timeSlotId = input.timeSlotId ?? session.timeSlotId;
  await assertSlotFree(teacherId, input.date, timeSlotId, `${session.id}|${input.part}`);
  const unchanged = input.date === session.date && input.classId === session.classId && timeSlotId === session.timeSlotId && !input.note;
  const key = and(eq(timesheetOverrides.sessionId, session.id), eq(timesheetOverrides.part, input.part));

  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx.select().from(timesheetOverrides).where(key).limit(1);
      if (unchanged) {
        if (before) {
          await tx.delete(timesheetOverrides).where(key);
          await audit(tx, { userId: actor.userId, action: "delete", tableName: "timesheet_overrides", recordId: before.id, oldValue: before });
        }
        return { edited: false };
      }
      const values = { date: input.date, timeSlotId: input.timeSlotId, classId: input.classId, note: input.note, updatedBy: actor.userId };
      const [row] = before
        ? await tx.update(timesheetOverrides).set({ ...values, updatedAt: new Date() }).where(key).returning()
        : await tx.insert(timesheetOverrides).values({ ...values, sessionId: session.id, part: input.part }).returning();
      await audit(tx, {
        userId: actor.userId,
        action: before ? "update" : "create",
        tableName: "timesheet_overrides",
        recordId: row!.id,
        oldValue: before,
        newValue: row,
      });
      return { edited: true };
    });
  } catch (e) {
    throw translateDbError(e);
  }
}

const STATE_LABEL: Record<TimesheetState, string> = { taught: "Đã dạy", pending: "Chưa điểm danh", upcoming: "Chưa tới ngày" };
const hoursOf = (minutes: number) => Math.round((minutes / 60) * 10) / 10;

/** Ghi chú của một dòng công: Buổi bù / Bổ sung / Đã sửa / chưa có mức lương, kèm ghi chú người dùng nhập. */
export const timesheetRemark = (r: Pick<TimesheetRow, "kind" | "source" | "edited" | "note" | "state" | "rate">) =>
  [
    r.kind === "makeup" ? "Buổi bù" : "",
    r.source === "manual" ? "Bổ sung" : "",
    r.edited ? "Đã sửa" : "",
    r.state === "taught" && r.rate === null ? "Chưa có mức lương" : "",
    r.note ?? "",
  ]
    .filter(Boolean)
    .join(" · ");

/** Mức lương của một người trong kỳ: một mức thì là số, nhiều lớp khác mức thì liệt kê, chưa có thì để trống. */
const ratesCell = (rates: number[]) => (rates.length === 0 ? "" : rates.length === 1 ? rates[0]! : rates.map((r) => r.toLocaleString("vi-VN")).join(" / "));

/**
 * Tệp chấm công để xuất. Không chọn giáo viên: tệp tổng hợp mọi giáo viên (tổng công + chi tiết).
 * Chọn một giáo viên: tệp riêng của người đó để gửi cho giáo viên xem.
 */
export async function timesheetDoc(actor: Actor, filters: TimesheetFilters, now: Date = new Date()): Promise<ExportDoc> {
  const { rows, summary } = await teacherTimesheet(actor, filters, now);
  const single = filters.teacherId ? (summary[0] ?? null) : null;
  const total = summary.reduce(
    (sum, s) => ({
      taught: sum.taught + s.taught,
      substitute: sum.substitute + s.substitute,
      assistant: sum.assistant + s.assistant,
      minutes: sum.minutes + s.minutes,
      pending: sum.pending + s.pending,
      amount: sum.amount + s.amount,
    }),
    { taught: 0, substitute: 0, assistant: 0, minutes: 0, pending: 0, amount: 0 },
  );
  return {
    filename: `cham-cong-${single ? single.teacherCode : "tong-hop"}-${filters.from}-${filters.to}`,
    title: single ? `Chấm công giáo viên ${single.teacherName} (${single.teacherCode})` : "Chấm công giáo viên – tổng hợp",
    subtitle: `Từ ${formatDate(filters.from)} đến ${formatDate(filters.to)}`,
    sections: [
      {
        title: "Tổng công",
        columns: [
          { header: "STT", width: 6, align: "center" },
          { header: "Mã GV", width: 14 },
          { header: "Giáo viên", width: 26 },
          { header: "Số buổi", width: 10, align: "center" },
          { header: "Dạy thay", width: 10, align: "center" },
          { header: "Trợ giảng", width: 10, align: "center" },
          { header: "Số giờ", width: 10, align: "center" },
          { header: "Chưa điểm danh", width: 16, align: "center" },
          { header: "Mức lương (đ)", width: 20, align: "right" },
          { header: "Thành tiền (đ)", width: 16, align: "right" },
          { header: "Ghi chú", width: 26 },
        ],
        rows: [
          ...summary.map((s, i) => [
            i + 1,
            s.teacherCode,
            s.teacherName,
            s.taught,
            s.substitute,
            s.assistant,
            hoursOf(s.minutes),
            s.pending,
            ratesCell(s.rates),
            s.amount,
            s.missingRate > 0 ? `${s.missingRate} công chưa có mức lương` : "",
          ]),
          ...(summary.length > 1
            ? [["", "", "Tổng cộng", total.taught, total.substitute, total.assistant, hoursOf(total.minutes), total.pending, "", total.amount, ""]]
            : []),
        ],
      },
      {
        title: "Chi tiết buổi dạy",
        columns: [
          { header: "STT", width: 6, align: "center" },
          { header: "Thứ", width: 10 },
          { header: "Ngày", width: 12 },
          { header: "Giờ", width: 13 },
          { header: "Mã GV", width: 14 },
          { header: "Giáo viên", width: 24 },
          { header: "Vai trò", width: 12 },
          { header: "Lớp", width: 26 },
          { header: "Trạng thái", width: 16 },
          { header: "Mức lương (đ)", width: 16, align: "right" },
          { header: "Thành tiền (đ)", width: 16, align: "right" },
          { header: "Ghi chú", width: 28 },
        ],
        rows: rows.map((r, i) => [
          i + 1,
          WEEKDAY_NAMES[isoWeekday(r.date)] ?? "",
          formatDate(r.date),
          `${formatTime(r.startTime)}–${formatTime(r.endTime)}`,
          r.teacherCode,
          r.teacherName,
          TIMESHEET_ROLE_LABEL[r.role],
          r.className,
          STATE_LABEL[r.state],
          r.rate ?? "",
          r.amount ?? "",
          timesheetRemark(r),
        ]),
      },
    ],
  };
}
