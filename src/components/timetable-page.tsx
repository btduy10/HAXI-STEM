import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { ExportLinks } from "@/components/class-report";
import { selectClass } from "@/components/form-dialog";
import { GenerateSessionsButton } from "@/components/generate-sessions-button";
import { ManualScheduler } from "@/components/manual-scheduler";
import { MonthView, TIMETABLE_ONLY_LABEL, TeacherLegend, type TimetableSession, WeekView, leadTeacherId } from "@/components/timetable";
import { Button } from "@/components/ui/button";
import { LinkButton } from "@/components/link-button";
import { TIMETABLE_ONLY_SHADE, teacherShade } from "@/domain/timetable-colors";
import { addDays, addMonths, endOfMonth, parseIsoDate, startOfMonth, startOfWeek } from "@/lib/dates";
import { formatDate, todayIso } from "@/lib/format";
import type { Actor } from "@/server/guard";
import { listRooms, listTeachers, listTimeSlotsForGrid } from "@/server/services/catalog";
import { listClasses } from "@/server/services/classes";
import { listSessions } from "@/server/services/sessions";

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const UUID = /^[0-9a-f-]{36}$/i;
const uuidOrEmpty = (v: string) => (UUID.test(v) ? v : "");

/**
 * Thời khóa biểu dùng chung. `manage` = trang quản lý (có bộ lọc GV/lớp/phòng); không thì là lịch cá nhân.
 * Phạm vi buổi học do service `listSessions` quyết định, không phụ thuộc tham số trên URL.
 */
export async function TimetablePage({
  actor,
  params,
  basePath,
  title,
  sessionHref,
  manage = false,
  canAdd = false,
}: {
  /** Trang quản lý Thời khóa biểu (menu được phân quyền), có bộ lọc. */
  manage?: boolean;
  /** Được xếp tay buổi học (quyền Thêm của menu Thời khóa biểu). */
  canAdd?: boolean;
  actor: Actor;
  params: Params;
  basePath: string;
  title: string;
  sessionHref: (session: TimetableSession) => string | undefined;
}) {
  const admin = manage;
  const today = todayIso();
  const view = one(params.view) === "month" ? "month" : "week";
  const date = parseIsoDate(one(params.date), today);
  const filters = admin
    ? { teacherId: uuidOrEmpty(one(params.teacherId)), classId: uuidOrEmpty(one(params.classId)), roomId: uuidOrEmpty(one(params.roomId)) }
    : { teacherId: "", classId: "", roomId: "" };

  const range =
    view === "week"
      ? { from: startOfWeek(date), to: addDays(startOfWeek(date), 6) }
      : { from: startOfWeek(startOfMonth(date)), to: addDays(startOfWeek(endOfMonth(date)), 6) };

  const [sessions, slots, teacherList, options] = await Promise.all([
    // Thời khóa biểu là nơi duy nhất hiện lớp "chỉ hiển thị trên Thời khóa biểu" (vd. cho mượn phòng).
    listSessions(actor, { ...range, ...filters, personal: !admin, includeTimetableOnly: true }),
    listTimeSlotsForGrid(),
    listTeachers(actor),
    admin ? Promise.all([listClasses(actor, { includeTimetableOnly: true }), listRooms(actor)]) : null,
  ]);

  // Màu theo giáo viên: giáo viên đang dạy xếp theo mã, mỗi người một màu (ba tông thương hiệu, quay vòng thì đậm dần).
  const activeTeachers = teacherList.filter((t) => t.status === "active");
  const shadeByTeacher = new Map(activeTeachers.map((t, index) => [t.id, teacherShade(index, activeTeachers.length)]));
  // Lớp chỉ xem lịch có màu xám riêng, không dùng màu của giáo viên.
  const shadeOf = (s: TimetableSession) => (s.timetableOnly ? TIMETABLE_ONLY_SHADE : shadeByTeacher.get(leadTeacherId(s) ?? ""));
  const shown = sessions.filter((s) => s.status !== "cancelled");
  const shownTeachers = new Set(shown.filter((s) => !s.timetableOnly).map(leadTeacherId));
  const legend = [
    ...activeTeachers
      .filter((t) => shownTeachers.has(t.id))
      .map((t) => ({ id: t.id, name: t.shortName || t.fullName, shade: shadeByTeacher.get(t.id)! })),
    ...(shown.some((s) => s.timetableOnly) ? [{ id: "timetable-only", name: TIMETABLE_ONLY_LABEL, shade: TIMETABLE_ONLY_SHADE }] : []),
  ];
  const href = (next: { view?: string; date?: string }) => {
    const query = new URLSearchParams({ view: next.view ?? view, date: next.date ?? date });
    for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
    return `${basePath}?${query}`;
  };
  const step = (dir: 1 | -1) => (view === "week" ? addDays(date, 7 * dir) : addMonths(date, dir));
  const heading =
    view === "week"
      ? `${formatDate(range.from)} – ${formatDate(addDays(range.from, 6))}`
      : `Tháng ${Number(date.slice(5, 7))}/${date.slice(0, 4)}`;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold sm:text-2xl">{title}</h1>
        <div className="flex glass-solid rounded-full border p-1 text-sm">
          {(["week", "month"] as const).map((v) => (
            <Link
              key={v}
              href={href({ view: v })}
              aria-current={view === v ? "page" : undefined}
              className={`rounded-full px-4 py-1.5 transition-colors ${view === v ? "bg-brand-teal font-semibold text-foreground shadow-sm" : "hover:bg-muted"}`}
            >
              {v === "week" ? "Tuần" : "Tháng"}
            </Link>
          ))}
        </div>
      </div>

      {options && (
        <form className="grid gap-2 sm:grid-cols-4">
          <input type="hidden" name="view" value={view} />
          <input type="hidden" name="date" value={date} />
          <select name="teacherId" defaultValue={filters.teacherId} aria-label="Lọc theo giáo viên" className={selectClass}>
            <option value="">Tất cả giáo viên</option>
            {teacherList.map((t) => (
              <option key={t.id} value={t.id}>
                {t.fullName}
              </option>
            ))}
          </select>
          <select name="classId" defaultValue={filters.classId} aria-label="Lọc theo lớp" className={selectClass}>
            <option value="">Tất cả lớp</option>
            {options[0].map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} – {c.name}
              </option>
            ))}
          </select>
          <select name="roomId" defaultValue={filters.roomId} aria-label="Lọc theo phòng" className={selectClass}>
            <option value="">Tất cả phòng</option>
            {options[1].map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <Button type="submit" variant="outline" className="h-11">
            Lọc
          </Button>
        </form>
      )}

      <div className="flex items-center justify-between gap-2">
        <LinkButton variant="outline" size="icon-lg" aria-label="Trước" href={href({ date: step(-1) })}>
          <ChevronLeftIcon />
        </LinkButton>
        <div className="flex min-w-0 flex-col items-center text-sm">
          <span className="font-medium">{heading}</span>
          <Link href={href({ date: today })} className="text-muted-foreground underline-offset-2 hover:underline">
            Hôm nay
          </Link>
        </div>
        <LinkButton variant="outline" size="icon-lg" aria-label="Sau" href={href({ date: step(1) })}>
          <ChevronRightIcon />
        </LinkButton>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <ExportLinks
          label="Xuất khoảng đang xem"
          baseHref={`/api/export/timetable?${new URLSearchParams({ from: range.from, to: range.to, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) })}`}
        />
        {/* Buổi học sinh theo từng tuần: bổ sung buổi tuần sau cho mọi lớp đang mở theo lịch mẫu, rồi mở tuần đó. */}
        {options && canAdd && <GenerateSessionsButton />}
      </div>

      <TeacherLegend entries={legend} />

      {view === "week" ? (
        options && canAdd ? (
          <ManualScheduler
            defaults={filters}
            options={{
              slots: slots.map((s) => ({ value: s.id, label: `${s.name} (${s.defaultStart.slice(0, 5)}–${s.defaultEnd.slice(0, 5)})` })),
              classes: options[0].filter((c) => c.status === "open").map((c) => ({ value: c.id, label: `${c.code} – ${c.name}` })),
              teachers: activeTeachers.map((t) => ({ value: t.id, label: `${t.code} – ${t.fullName}` })),
              rooms: options[1].map((r) => ({ value: r.id, label: `${r.name} (${r.capacity} chỗ)` })),
            }}
          >
            <p className="text-sm text-muted-foreground">Bấm dấu + ở một ô để xếp tay một buổi học vào ngày và ca đó.</p>
            <WeekView sessions={sessions} date={date} slots={slots} hrefOf={sessionHref} today={today} shadeOf={shadeOf} />
          </ManualScheduler>
        ) : (
          <WeekView sessions={sessions} date={date} slots={slots} hrefOf={sessionHref} today={today} shadeOf={shadeOf} />
        )
      ) : (
        <MonthView sessions={sessions} date={date} dayHref={(day) => href({ view: "week", date: day })} today={today} shadeOf={shadeOf} />
      )}
    </div>
  );
}
