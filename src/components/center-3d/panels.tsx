"use client";

import { ArrowLeftIcon, HomeIcon, type LucideIcon, MinusIcon, PlusIcon, RotateCwIcon, ScanIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { CountUp } from "@/components/count-up";
import {
  type CenterRoom,
  type CenterSession,
  type DayProgress,
  ROOM_STATE_LABELS,
  type RoomState,
  minutesOf,
  sessionProgress,
} from "@/domain/center-3d";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { SceneApi } from "./center-scene";
import { STATE_DOT } from "./theme";
import type { OverdueItem } from "./top-bar";

// Các thẻ trắng nổi trên cảnh 3D của trang Tổng quan. Mọi thẻ là HTML thường: dùng được bằng bàn phím và trên điện thoại.

export type StageKpi = {
  label: string;
  value: number;
  /** Trang của số liệu; null khi không có trang riêng (thẻ không bấm được). */
  href: string | null;
  /** Số cần chú ý (vd. buổi quá hạn) khi lớn hơn 0. */
  alert?: boolean;
};
export type StageClass = { id: string; title: string; detail: string; href: string };
export type RoomRow = { room: CenterRoom; state: RoomState; session: CenterSession | null };

const focusRing = "outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const empty = "rounded-xl border border-dashed p-3 text-center text-sm text-ink-soft";

/** Trạng thái của một buổi lúc `now`, để ghi huy hiệu ở danh sách. */
function sessionState(session: CenterSession, now: string): { label: string; className: string } {
  if (session.cancelled) return { label: "Đã hủy", className: "bg-muted text-ink-soft" };
  if (session.endTime <= now) return { label: "Đã xong", className: "bg-state-done/45 text-primary-strong" };
  if (session.startTime <= now) return { label: "Đang học", className: "bg-primary text-primary-foreground" };
  return { label: "Sắp học", className: "bg-brand-gold-soft text-foreground" };
}

function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("inline-flex h-5.5 shrink-0 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap", className)}>{children}</span>;
}

/** Hàng thẻ KPI. Thẻ có trang riêng là một đường dẫn tới trang của số liệu đó. */
export function Kpis({ items, className }: { items: StageKpi[]; className?: string }) {
  const card = "panel flex h-full flex-col justify-between gap-1.5 px-3.5 py-3";
  return (
    <ul className={cn("grid grid-cols-2 gap-2 md:flex", className)} aria-label="Số liệu chính">
      {items.map((item) => {
        const body = (
          <>
            <span className="text-xs leading-tight text-ink-soft">{item.label}</span>
            <span className={cn("text-3xl leading-none font-semibold tabular-nums", item.alert && item.value > 0 ? "text-danger" : "text-foreground")}>
              <CountUp value={item.value} />
            </span>
          </>
        );
        return (
          <li key={item.label} className="min-w-0 md:w-37">
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

function SessionItem({ session, capacity, now }: { session: CenterSession; capacity: number | null; now: string }) {
  const state = sessionState(session, now);
  return (
    <li className="grid grid-cols-1 gap-1 rounded-xl border bg-background/70 p-2.5 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold tabular-nums">
          {session.startTime}–{session.endTime}
        </span>
        <Chip className={state.className}>{state.label}</Chip>
      </div>
      <span className="break-words">{session.className}</span>
      <span className="text-ink-soft">
        {session.teacherName ? `GV: ${session.teacherName}` : "Chưa có giáo viên"}
        {session.studentCount !== null && ` · Sĩ số ${session.studentCount}${capacity === null ? "" : `/${capacity}`}`}
        {session.timetableOnly && " · Chỉ giữ phòng"}
      </span>
      {session.href && (
        <Link href={session.href} className={cn("w-fit rounded font-medium text-primary underline-offset-2 hover:underline", focusRing)}>
          Mở buổi học
        </Link>
      )}
    </li>
  );
}

/**
 * Thẻ chi tiết bên phải: chưa chọn phòng thì là danh sách phòng theo trạng thái; chọn một phòng (ở đây, ở cảnh 3D hoặc qua
 * tìm kiếm) thì hiện các buổi hôm nay của phòng kèm đường mở buổi học.
 */
export function RoomPanel({
  className,
  today,
  now,
  rooms,
  sessionsOf,
  unplaced,
  selectedId,
  onSelect,
}: {
  className?: string;
  today: string;
  now: string;
  rooms: RoomRow[];
  sessionsOf: Map<string, CenterSession[]>;
  /** Buổi hôm nay chưa xếp phòng. */
  unplaced: CenterSession[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const selected = rooms.find((row) => row.room.id === selectedId) ?? null;
  const sessions = selected ? [...(sessionsOf.get(selected.room.id) ?? [])].sort((a, b) => a.startTime.localeCompare(b.startTime)) : [];
  return (
    <section aria-label="Phòng học hôm nay" className={cn("panel flex min-h-0 flex-col gap-3 p-3.5", className)}>
      {selected ? (
        <>
          <div className="grid gap-2">
            <button type="button" onClick={() => onSelect(null)} className={cn("flex w-fit items-center gap-1 rounded-full text-xs font-medium text-primary hover:underline", focusRing)}>
              <ArrowLeftIcon className="size-3.5" aria-hidden />
              Tất cả phòng
            </button>
            <div className="flex items-start justify-between gap-2">
              <h2 className="min-w-0 text-base leading-tight font-semibold break-words">{selected.room.name}</h2>
              <Chip className="bg-primary-soft text-primary-strong">
                <span aria-hidden className={cn("mr-1.5 size-2 rounded-full", STATE_DOT[selected.state])} />
                {ROOM_STATE_LABELS[selected.state]}
              </Chip>
            </div>
            <p className="text-sm text-ink-soft">
              Sức chứa {selected.room.capacity} chỗ · {sessions.length} buổi hôm nay
            </p>
          </div>
          {sessions.length === 0 ? (
            <p className={empty}>Hôm nay phòng không có buổi học.</p>
          ) : (
            <ul className="grid min-h-0 grid-cols-1 content-start gap-1.5 overflow-y-auto" aria-live="polite">
              {sessions.map((session) => (
                <SessionItem key={session.id} session={session} capacity={selected.room.capacity} now={now} />
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          <div>
            <h2 className="text-base leading-tight font-semibold">Phòng học hôm nay</h2>
            <p className="text-sm text-ink-soft">{formatDate(today)} · bấm một phòng để xem buổi học</p>
          </div>
          <div className="grid min-h-0 grid-cols-1 content-start gap-3 overflow-y-auto">
            {rooms.length === 0 ? (
              <p className={empty}>Chưa có phòng học nào. Thêm phòng ở Phòng &amp; Ca học.</p>
            ) : (
              <ul className="grid grid-cols-1 gap-1.5">
                {rooms.map(({ room, state, session }) => (
                  <li key={room.id}>
                    <button
                      type="button"
                      data-room={room.name}
                      data-state={state}
                      onClick={() => onSelect(room.id)}
                      className={cn("flex min-h-11 w-full items-center gap-2.5 rounded-xl border bg-background/70 px-3 py-2 text-left text-sm transition-colors hover:bg-primary-soft", focusRing)}
                    >
                      <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", STATE_DOT[state])} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{room.name}</span>
                        <span className="block truncate text-xs text-ink-soft">
                          {ROOM_STATE_LABELS[state]}
                          {session && state !== "done" && ` · ${session.startTime}–${session.endTime} · ${session.className}`}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-ink-soft tabular-nums">{room.capacity} chỗ</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {unplaced.length > 0 && (
              <div className="grid grid-cols-1 gap-1.5">
                <h3 className="text-sm font-medium">Buổi chưa xếp phòng</h3>
                <ul className="grid grid-cols-1 gap-1.5">
                  {unplaced.map((session) => (
                    <SessionItem key={session.id} session={session} capacity={null} now={now} />
                  ))}
                </ul>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Bar({ value, label, className }: { value: number; label: string; className?: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className={cn("h-2 overflow-hidden rounded-full bg-primary-soft", className)}>
      <div className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Thẻ tiến trình buổi học hôm nay: phần trăm của ngày, số buổi theo trạng thái và thanh tiến trình của từng buổi đang học. */
export function ProgressPanel({
  className,
  progress,
  live,
  now,
  roomNameOf,
}: {
  className?: string;
  progress: DayProgress;
  /** Các buổi đang học lúc này. */
  live: CenterSession[];
  now: string;
  roomNameOf: (roomId: string | null) => string | null;
}) {
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

type ListTab = "today" | "overdue" | "classes";

/** Thẻ danh sách có tab: buổi hôm nay, buổi quá hạn chưa điểm danh, và các lớp (theo phạm vi của người dùng). */
export function ListsPanel({
  className,
  now,
  sessions,
  roomNameOf,
  overdue,
  overdueTotal,
  overdueHref,
  classes,
  classesLabel,
  classesEmpty,
}: {
  className?: string;
  now: string;
  sessions: CenterSession[];
  roomNameOf: (roomId: string | null) => string | null;
  overdue: OverdueItem[];
  overdueTotal: number;
  overdueHref: string | null;
  classes: StageClass[];
  classesLabel: string;
  classesEmpty: string;
}) {
  const [tab, setTab] = useState<ListTab>("today");
  const tabs: { key: ListTab; label: string; count: number }[] = [
    { key: "today", label: "Hôm nay", count: sessions.length },
    { key: "overdue", label: "Quá hạn", count: overdueTotal },
    { key: "classes", label: classesLabel, count: classes.length },
  ];
  const row = cn("grid grid-cols-1 gap-0.5 rounded-xl border bg-background/70 px-3 py-2 text-sm", focusRing);
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
            <span className="tabular-nums opacity-80">({item.count})</span>
          </button>
        ))}
      </div>
      <div id="stage-tabpanel" role="tabpanel" aria-labelledby={`stage-tab-${tab}`} className="grid min-h-0 grid-cols-1 content-start gap-1.5 overflow-y-auto">
        {tab === "today" &&
          (sessions.length === 0 ? (
            <p className={empty}>Hôm nay không có buổi học.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-1.5">
              {sessions.map((session) => {
                const state = sessionState(session, now);
                const room = roomNameOf(session.roomId);
                const body = (
                  <>
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-semibold tabular-nums">
                        {session.startTime}–{session.endTime}
                      </span>
                      <Chip className={state.className}>{state.label}</Chip>
                    </span>
                    <span className="truncate">{session.className}</span>
                    <span className="truncate text-xs text-ink-soft">
                      {[room ?? "Chưa xếp phòng", session.teacherName].filter(Boolean).join(" · ")}
                    </span>
                  </>
                );
                return (
                  <li key={session.id} data-session={session.className}>
                    {session.href ? (
                      <Link href={session.href} className={cn(row, "hover:bg-primary-soft")}>
                        {body}
                      </Link>
                    ) : (
                      <div className={row}>{body}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          ))}
        {tab === "overdue" &&
          (overdue.length === 0 ? (
            <p className={empty}>Không có buổi nào quá hạn.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-1.5">
              {overdue.map((item) => (
                <li key={item.id}>
                  <Link href={item.href} className={cn(row, "hover:bg-primary-soft")}>
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{item.title}</span>
                      <Chip className={item.locked ? "bg-muted text-ink-soft" : "bg-danger/12 text-danger"}>{item.locked ? "Đã khóa" : "Cần điểm danh"}</Chip>
                    </span>
                    <span className="text-xs text-ink-soft">{item.detail}</span>
                  </Link>
                </li>
              ))}
              {overdueHref && overdueTotal > overdue.length && (
                <li>
                  <Link href={overdueHref} className={cn("block rounded-xl px-3 py-2 text-sm font-medium text-primary hover:underline", focusRing)}>
                    Xem tất cả {overdueTotal} buổi ở Điểm danh
                  </Link>
                </li>
              )}
            </ul>
          ))}
        {tab === "classes" &&
          (classes.length === 0 ? (
            <p className={empty}>{classesEmpty}</p>
          ) : (
            <ul className="grid grid-cols-1 gap-1.5">
              {classes.map((item) => (
                <li key={item.id}>
                  <Link href={item.href} className={cn(row, "hover:bg-primary-soft")}>
                    <span className="truncate font-medium">{item.title}</span>
                    <span className="truncate text-xs text-ink-soft">{item.detail}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </section>
  );
}

/** Cột nút tròn điều khiển máy quay của cảnh 3D. */
export function CameraButtons({ api, disabled, className }: { api: { current: SceneApi | null }; disabled: boolean; className?: string }) {
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
          className={cn(
            "grid size-10 place-items-center rounded-full border bg-card text-foreground shadow-panel transition-colors hover:bg-primary hover:text-primary-foreground disabled:opacity-50",
            focusRing,
          )}
        >
          <Icon className="size-[1.125rem]" aria-hidden />
        </button>
      ))}
    </div>
  );
}
