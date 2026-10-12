"use client";

import { ArrowDownRightIcon, ArrowUpRightIcon, BoxIcon, CheckIcon, HomeIcon, LayoutGridIcon, type LucideIcon, MinusIcon, PlusIcon, RotateCwIcon, ScanIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { CountUp } from "@/components/count-up";
import { type CenterSession, type DayProgress, type KpiDelta, type SessionStep, minutesOf, sessionProgress } from "@/domain/center-3d";
import { cn } from "@/lib/utils";
import type { CenterSessionDetail } from "@/server/services/center-detail";
import type { SceneApi } from "./center-scene";
import type { StagePerms } from "./detail-panels";
import { ATTENDANCE, Bar, Chip, ErrorNote, Skeleton, Stars, emptyBox, focusRing, listRow, sessionState } from "./parts";
import type { Remote } from "./use-remote";

// Các thẻ trắng nổi trên cảnh 3D của trang Tổng quan. Mọi thẻ là HTML thường: dùng được bằng bàn phím và trên điện thoại.

export type StageKpi = {
  label: string;
  /** null = chưa có dữ liệu (ghi "–"). */
  value: number | null;
  /** Đơn vị ghi sau số, vd. "%". */
  suffix?: string;
  /** Trang của số liệu; null khi không có trang riêng (thẻ không bấm được). */
  href: string | null;
  /** Số cần chú ý (vd. buổi quá hạn) khi lớn hơn 0. */
  alert?: boolean;
  /** Chênh lệch so với kỳ trước, kèm tên kỳ trước ("tuần trước"). Không có thì không vẽ mũi tên. */
  delta?: (KpiDelta & { versus: string }) | null;
};

const DELTA_WORD = { up: "tăng", down: "giảm", flat: "không đổi" } as const;

/** Hàng thẻ KPI. Thẻ có trang riêng là một đường dẫn tới trang của số liệu đó. */
export function Kpis({ items, className }: { items: StageKpi[]; className?: string }) {
  const card = "panel flex h-full flex-col justify-between gap-1.5 px-3.5 py-3";
  return (
    <ul className={cn("grid grid-cols-2 gap-2 md:flex", className)} aria-label="Số liệu chính">
      {items.map((item) => {
        const delta = item.delta;
        const amount = delta ? `${delta.diff}${item.suffix ?? ""}` : "";
        const body = (
          <>
            <span className="text-xs leading-tight text-ink-soft">{item.label}</span>
            <span className="flex items-end justify-between gap-1.5">
              <span className={cn("text-3xl leading-none font-semibold tabular-nums", item.alert && (item.value ?? 0) > 0 ? "text-danger" : "text-foreground")} data-kpi-value>
                {item.value === null ? (
                  "–"
                ) : (
                  <>
                    {/* Hiệu ứng đếm chỉ làm việc với số nguyên (tỉ lệ có phần thập phân ghi thẳng) và chỉ chạy lúc gắn: số đổi sau khi
                        dữ liệu được làm mới thì gắn lại để hiện số mới. */}
                    {Number.isInteger(item.value) ? <CountUp key={item.value} value={item.value} /> : item.value}
                    {item.suffix && <span className="text-lg">{item.suffix}</span>}
                  </>
                )}
              </span>
              {delta && (
                <span
                  data-kpi-delta={delta.direction}
                  title={`So với ${delta.versus}`}
                  className={cn(
                    "flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium tabular-nums",
                    delta.direction === "up" ? "bg-primary-soft text-primary-strong" : delta.direction === "down" ? "bg-danger/10 text-danger" : "bg-muted text-ink-soft",
                  )}
                >
                  {delta.direction === "up" ? <ArrowUpRightIcon className="size-3" aria-hidden /> : delta.direction === "down" ? <ArrowDownRightIcon className="size-3" aria-hidden /> : <MinusIcon className="size-3" aria-hidden />}
                  <span aria-hidden>{delta.direction === "flat" ? "0" : amount}</span>
                  <span className="sr-only">
                    {delta.direction === "flat" ? `không đổi so với ${delta.versus}` : `${DELTA_WORD[delta.direction]} ${amount} so với ${delta.versus}`}
                  </span>
                </span>
              )}
            </span>
          </>
        );
        return (
          <li key={item.label} className="min-w-0 md:w-37" data-kpi={item.label}>
            {item.href ? (
              <Link href={item.href} className={cn(card, "transition-transform hover:-translate-y-0.5 motion-reduce:transition-none", focusRing)}>
                {body}
              </Link>
            ) : (
              <div className={card}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Thẻ tiến trình. Có buổi đang chọn: năm bước của buổi (Lên lịch → Điểm danh → Đang học → Chấm sao → Hoàn tất) kèm giờ thật
 * của từng bước. Chưa chọn buổi: tiến trình của cả ngày và thanh tiến trình của các buổi đang học.
 */
export function ProgressPanel({
  className,
  progress,
  live,
  now,
  roomNameOf,
  selected,
}: {
  className?: string;
  progress: DayProgress;
  /** Các buổi đang học lúc này. */
  live: CenterSession[];
  now: string;
  roomNameOf: (roomId: string | null) => string | null;
  /** Buổi đang chọn và các bước của nó. */
  selected: { session: CenterSession; steps: SessionStep[] } | null;
}) {
  if (selected) {
    const { session, steps } = selected;
    const done = steps.filter((step) => step.state === "done").length;
    return (
      <section aria-label="Tiến trình buổi học đang chọn" className={cn("panel grid content-start gap-3 p-3.5", className)}>
        <div className="flex items-end justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base leading-tight font-semibold">Tiến trình buổi học</h2>
            <p className="truncate text-sm text-ink-soft">
              {session.className} · {session.startTime}–{session.endTime}
            </p>
          </div>
          <p className="shrink-0 text-2xl leading-none font-semibold text-brand-gold tabular-nums">
            {done}/{steps.length}
          </p>
        </div>
        {session.cancelled && <p className="rounded-xl bg-muted px-3 py-2 text-sm text-ink-soft">Buổi đã hủy nên các bước sau không diễn ra.</p>}
        <ol className="grid grid-cols-1" data-session-steps>
          {steps.map((step, index) => (
            <li key={step.key} data-step={step.key} data-step-state={step.state} className="flex gap-2.5">
              <span className="flex flex-col items-center" aria-hidden>
                <span
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full border-2",
                    step.state === "done" ? "border-primary bg-primary text-primary-foreground" : step.state === "current" ? "border-brand-gold bg-brand-gold-soft" : "border-state-idle bg-card",
                  )}
                >
                  {step.state === "done" && <CheckIcon className="size-3" strokeWidth={3} />}
                  {step.state === "current" && <span className="size-1.5 animate-pulse rounded-full bg-brand-gold motion-reduce:animate-none" />}
                </span>
                {index < steps.length - 1 && <span className={cn("w-0.5 flex-1", step.state === "done" ? "bg-primary" : "bg-state-idle")} />}
              </span>
              <span className={cn("flex min-w-0 flex-1 items-baseline justify-between gap-2 text-sm", index < steps.length - 1 && "pb-2.5")}>
                <span className={cn("font-medium", step.state === "pending" && "font-normal text-ink-soft")}>
                  {step.label}
                  <span className="sr-only">: {step.state === "done" ? "đã xong" : step.state === "current" ? "đang chờ" : "chưa tới"}</span>
                </span>
                <span className="shrink-0 text-xs text-ink-soft tabular-nums">{step.at ?? (step.state === "current" ? "đang chờ" : step.state === "done" ? "" : "chưa")}</span>
              </span>
            </li>
          ))}
        </ol>
        <p className="border-t pt-2.5 text-xs text-ink-soft">
          Cả ngày: {progress.done}/{progress.total} buổi đã xong · {progress.percent}%
        </p>
      </section>
    );
  }

  const stats = [
    { label: "Đang học", value: progress.live, dot: "bg-state-live" },
    { label: "Sắp học", value: progress.upcoming, dot: "bg-state-upcoming" },
    { label: "Đã xong", value: progress.done, dot: "bg-state-done" },
    ...(progress.cancelled > 0 ? [{ label: "Đã hủy", value: progress.cancelled, dot: "bg-state-idle" }] : []),
  ];
  return (
    <section aria-label="Tiến trình buổi học hôm nay" className={cn("panel grid content-start gap-3 p-3.5", className)}>
      <div className="flex items-end justify-between gap-2">
        <div>
          <h2 className="text-base leading-tight font-semibold">Tiến trình hôm nay</h2>
          <p className="text-sm text-ink-soft">
            {progress.total === 0 ? "Hôm nay không có buổi học." : `${progress.done}/${progress.total} buổi đã xong`}
          </p>
        </div>
        <p className="text-3xl leading-none font-semibold text-brand-gold tabular-nums" data-day-percent>
          {progress.percent}%
        </p>
      </div>
      <Bar value={progress.percent / 100} label="Tiến trình các buổi học hôm nay" className="h-2.5" />
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {stats.map((stat) => (
          <li key={stat.label} className="flex items-center gap-1.5">
            <span aria-hidden className={cn("size-2 rounded-full", stat.dot)} />
            <span className="font-semibold tabular-nums">{stat.value}</span>
            <span className="text-ink-soft">{stat.label.toLowerCase()}</span>
          </li>
        ))}
      </ul>
      {live.length > 0 && (
        <ul className="grid grid-cols-1 gap-2 border-t pt-3">
          {live.slice(0, 3).map((session) => {
            const left = Math.max(0, minutesOf(session.endTime) - minutesOf(now));
            const room = roomNameOf(session.roomId);
            return (
              <li key={session.id} className="grid grid-cols-1 gap-1 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate font-medium">
                    {session.className}
                    {room && <span className="font-normal text-ink-soft"> · {room}</span>}
                  </span>
                  <span className="shrink-0 text-xs text-ink-soft tabular-nums">còn {left} phút</span>
                </div>
                <Bar value={sessionProgress(session, now)} label={`Tiến trình buổi ${session.className}`} />
              </li>
            );
          })}
          {live.length > 3 && <li className="text-xs text-ink-soft">và {live.length - 3} buổi đang học khác</li>}
        </ul>
      )}
    </section>
  );
}

export type TeacherRow = { id: string; name: string; total: number; done: number; live: boolean };
type ListTab = "classes" | "teachers" | "students";

/**
 * Thẻ danh sách có tab: Lớp (các buổi hôm nay), Giáo viên (người dạy hôm nay), Học viên (của buổi đang chọn).
 * Mỗi dòng có thanh trạng thái; bấm một dòng là chọn đối tượng đó (cảnh 3D bay tới, thẻ chi tiết đổi theo).
 */
export function ListsPanel({
  className,
  now,
  sessions,
  teachers,
  roomNameOf,
  selectedSessionId,
  selectedPersonId,
  selectedClassName,
  roster,
  perms,
  onSession,
  onTeacher,
  onStudent,
}: {
  className?: string;
  now: string;
  sessions: CenterSession[];
  teachers: TeacherRow[];
  roomNameOf: (roomId: string | null) => string | null;
  selectedSessionId: string | null;
  selectedPersonId: string | null;
  /** Tên lớp của buổi đang chọn (cho tab Học viên). */
  selectedClassName: string | null;
  /** Danh sách học viên của buổi đang chọn; chỉ có khi đã chọn một buổi có học viên. */
  roster: Remote<CenterSessionDetail> | null;
  perms: StagePerms;
  onSession: (id: string) => void;
  onTeacher: (id: string, name: string) => void;
  onStudent: (id: string, name: string) => void;
}) {
  const [tab, setTab] = useState<ListTab>("classes");
  const students = roster?.data?.students ?? null;
  const tabs: { key: ListTab; label: string; count: number | null }[] = [
    { key: "classes", label: "Lớp", count: sessions.length },
    { key: "teachers", label: "Giáo viên", count: teachers.length },
    { key: "students", label: "Học viên", count: students ? students.length : null },
  ];
  const picked = "border-primary bg-primary-soft";
  return (
    <section aria-label="Danh sách" className={cn("panel flex min-h-0 flex-col gap-2.5 p-3.5", className)}>
      <div role="tablist" aria-label="Chọn danh sách" className="flex gap-1 rounded-full bg-primary-soft p-1">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            id={`stage-tab-${item.key}`}
            aria-selected={tab === item.key}
            aria-controls="stage-tabpanel"
            onClick={() => setTab(item.key)}
            className={cn(
              "flex min-h-8 flex-1 items-center justify-center gap-1 rounded-full px-2 text-xs font-medium whitespace-nowrap transition-colors",
              focusRing,
              tab === item.key ? "bg-primary text-primary-foreground" : "text-primary-strong hover:bg-card",
            )}
          >
            {item.label}
            {item.count !== null && <span className="tabular-nums">({item.count})</span>}
          </button>
        ))}
      </div>
      <div id="stage-tabpanel" role="tabpanel" aria-labelledby={`stage-tab-${tab}`} className="grid min-h-0 grid-cols-1 content-start gap-1.5 overflow-y-auto">
        {tab === "classes" &&
          (sessions.length === 0 ? (
            <p className={emptyBox}>Hôm nay không có buổi học.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-1.5">
              {sessions.map((session) => {
                const state = sessionState(session, now);
                const room = roomNameOf(session.roomId);
                return (
                  <li key={session.id} data-session={session.className}>
                    <button type="button" aria-pressed={session.id === selectedSessionId} onClick={() => onSession(session.id)} className={cn(listRow, session.id === selectedSessionId && picked)}>
                      <span className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-medium">{session.className}</span>
                        <Chip className={state.className}>{state.label}</Chip>
                      </span>
                      <span className="truncate text-xs text-ink-soft">
                        <span className="tabular-nums">
                          {session.startTime}–{session.endTime}
                        </span>
                        {" · "}
                        {[room ?? "Chưa xếp phòng", session.teacherName].filter(Boolean).join(" · ")}
                        {!session.timetableOnly && !session.cancelled && (session.attendanceCount > 0 ? " · đã điểm danh" : session.startTime <= now ? " · chưa điểm danh" : "")}
                      </span>
                      <Bar value={session.cancelled ? 0 : sessionProgress(session, now)} label={`Tiến trình buổi ${session.className}`} className="mt-0.5 h-1.5" fill={state.bar} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ))}
        {tab === "teachers" &&
          (teachers.length === 0 ? (
            <p className={emptyBox}>Hôm nay chưa có giáo viên nào đứng lớp.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-1.5">
              {teachers.map((teacher) => (
                <li key={teacher.id} data-teacher={teacher.name}>
                  <button type="button" aria-pressed={teacher.id === selectedPersonId} onClick={() => onTeacher(teacher.id, teacher.name)} className={cn(listRow, teacher.id === selectedPersonId && picked)}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium">{teacher.name}</span>
                      <Chip className={teacher.live ? "bg-primary text-primary-foreground" : teacher.done === teacher.total ? "bg-state-done/45 text-primary-strong" : "bg-brand-gold-soft text-foreground"}>
                        {teacher.live ? "Đang dạy" : teacher.done === teacher.total ? "Đã dạy xong" : "Sắp dạy"}
                      </Chip>
                    </span>
                    <span className="text-xs text-ink-soft tabular-nums">
                      {teacher.done}/{teacher.total} buổi hôm nay đã xong
                    </span>
                    <Bar value={teacher.total === 0 ? 0 : teacher.done / teacher.total} label={`Số buổi đã dạy xong của ${teacher.name}`} className="mt-0.5 h-1.5" />
                  </button>
                </li>
              ))}
            </ul>
          ))}
        {tab === "students" &&
          (!roster ? (
            <p className={emptyBox}>Chọn một lớp ở tab Lớp hoặc bấm một phòng để xem học viên của buổi đó.</p>
          ) : !perms.attendance ? (
            <p className={emptyBox}>Bạn không có quyền xem danh sách học viên của buổi.</p>
          ) : roster.error ? (
            <ErrorNote message={roster.error} onRetry={roster.retry} />
          ) : !students ? (
            <Skeleton rows={3} label="Đang tải danh sách học viên" />
          ) : students.length === 0 ? (
            <p className={emptyBox}>Buổi học không có học viên nào.</p>
          ) : (
            <>
              {selectedClassName && <p className="px-1 text-xs text-ink-soft">{selectedClassName}</p>}
              <ul className="grid grid-cols-1 gap-1.5">
                {students.map((student) => {
                  const mark = student.status ? ATTENDANCE[student.status] : null;
                  const body = (
                    <>
                      <span className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate font-medium">{student.fullName}</span>
                        <Stars session={student.sessionStars} total={student.total} />
                      </span>
                      <span className="truncate text-xs text-ink-soft">
                        {student.code} · {mark ? mark.label : "Chưa điểm danh"}
                      </span>
                      <span aria-hidden className={cn("mt-0.5 h-1.5 rounded-full", mark ? mark.dot : "bg-primary-soft")} />
                    </>
                  );
                  return (
                    <li key={student.studentId}>
                      {perms.students ? (
                        <button type="button" aria-pressed={student.studentId === selectedPersonId} onClick={() => onStudent(student.studentId, student.fullName)} className={cn(listRow, student.studentId === selectedPersonId && picked)}>
                          {body}
                        </button>
                      ) : (
                        <div className={cn(listRow, "hover:bg-background/70")}>{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          ))}
      </div>
    </section>
  );
}

/**
 * Cột nút tròn điều khiển máy quay của cảnh 3D, và nút đổi giữa cảnh 3D với "Giao diện nhẹ" (sơ đồ 2D).
 * Ở giao diện nhẹ chỉ còn nút đổi giao diện; máy không chạy được 3D thì nút đó bị khóa.
 */
export function CameraButtons({
  api,
  disabled,
  className,
  flat,
  canUse3d,
  onToggleView,
}: {
  api: { current: SceneApi | null };
  disabled: boolean;
  className?: string;
  flat: boolean;
  canUse3d: boolean;
  onToggleView: () => void;
}) {
  const round = cn(
    "grid size-10 place-items-center rounded-full border bg-card text-foreground shadow-panel transition-colors hover:bg-primary hover:text-primary-foreground disabled:opacity-50 disabled:hover:bg-card disabled:hover:text-foreground",
    focusRing,
  );
  const toggleLabel = flat ? (canUse3d ? "Chuyển sang cảnh 3D" : "Máy này không hiển thị được cảnh 3D") : "Chuyển sang giao diện nhẹ";
  const toggle = (
    <button type="button" aria-label={toggleLabel} title={toggleLabel} data-view-toggle={flat ? "flat" : "3d"} disabled={flat && !canUse3d} onClick={onToggleView} className={round}>
      {flat ? <BoxIcon className="size-[1.125rem]" aria-hidden /> : <LayoutGridIcon className="size-[1.125rem]" aria-hidden />}
    </button>
  );
  if (flat) {
    return (
      <div role="group" aria-label="Đổi giao diện" className={cn("grid gap-2", className)}>
        {toggle}
      </div>
    );
  }
  const buttons: { label: string; icon: LucideIcon; run: (scene: SceneApi) => void }[] = [
    { label: "Phóng to", icon: PlusIcon, run: (scene) => scene.zoomIn() },
    { label: "Thu nhỏ", icon: MinusIcon, run: (scene) => scene.zoomOut() },
    { label: "Xoay 45°", icon: RotateCwIcon, run: (scene) => scene.rotate() },
    { label: "Đặt lại góc nhìn", icon: ScanIcon, run: (scene) => scene.reset() },
    { label: "Về tòa nhà chính", icon: HomeIcon, run: (scene) => scene.home() },
  ];
  return (
    <div role="group" aria-label="Điều khiển góc nhìn" className={cn("grid gap-2", className)}>
      {buttons.map(({ label, icon: Icon, run }) => (
        <button
          key={label}
          type="button"
          aria-label={label}
          title={label}
          disabled={disabled}
          onClick={() => api.current && run(api.current)}
          className={round}
        >
          <Icon className="size-[1.125rem]" aria-hidden />
        </button>
      ))}
      {toggle}
    </div>
  );
}
