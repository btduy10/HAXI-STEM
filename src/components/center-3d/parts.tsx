"use client";

import { RotateCwIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { CenterSession } from "@/domain/center-3d";
import { cn } from "@/lib/utils";

// Mảnh ghép dùng chung của các thẻ trên dashboard 3D: vòng focus, huy hiệu, thanh tiến trình, khung chờ, báo lỗi, ô rỗng.

export const focusRing = "outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
export const emptyBox = "rounded-xl border border-dashed p-3 text-center text-sm text-ink-soft";
/** Một dòng bấm được trong danh sách của thẻ. */
export const listRow = cn("grid w-full grid-cols-1 gap-0.5 rounded-xl border bg-background/70 px-3 py-2 text-left text-sm transition-colors hover:bg-primary-soft", focusRing);

export function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cn("inline-flex h-5.5 shrink-0 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap", className)}>{children}</span>;
}

export function Bar({ value, label, className, fill = "bg-primary" }: { value: number; label: string; className?: string; fill?: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className={cn("h-2 overflow-hidden rounded-full bg-primary-soft", className)}>
      <div className={cn("h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none", fill)} style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Trạng thái của một buổi lúc `now`, để ghi huy hiệu ở danh sách. */
export function sessionState(session: Pick<CenterSession, "cancelled" | "startTime" | "endTime">, now: string): { label: string; className: string; bar: string } {
  if (session.cancelled) return { label: "Đã hủy", className: "bg-muted text-ink-soft", bar: "bg-state-idle" };
  if (session.endTime <= now) return { label: "Đã xong", className: "bg-state-done/45 text-primary-strong", bar: "bg-state-done" };
  if (session.startTime <= now) return { label: "Đang học", className: "bg-primary text-primary-foreground", bar: "bg-state-live" };
  return { label: "Sắp học", className: "bg-brand-gold-soft text-foreground", bar: "bg-state-upcoming" };
}

export type AttendanceStatus = "present" | "late" | "left_early" | "excused" | "absent";
export const ATTENDANCE: Record<AttendanceStatus, { label: string; dot: string }> = {
  present: { label: "Có mặt", dot: "bg-state-live" },
  late: { label: "Đi trễ", dot: "bg-state-upcoming" },
  left_early: { label: "Về sớm", dot: "bg-brand-teal" },
  excused: { label: "Vắng có phép", dot: "bg-state-idle" },
  absent: { label: "Vắng không phép", dot: "bg-danger" },
};

/** Khung xám nhấp nháy khi đang tải chi tiết. */
export function Skeleton({ rows = 4, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="grid grid-cols-1 gap-2">
      <div className="h-5 w-2/3 animate-pulse rounded-md bg-primary-soft motion-reduce:animate-none" />
      <div className="h-4 w-1/2 animate-pulse rounded-md bg-primary-soft motion-reduce:animate-none" />
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="h-11 animate-pulse rounded-xl bg-primary-soft/70 motion-reduce:animate-none" />
      ))}
    </div>
  );
}

/** Không tải được chi tiết: nêu lý do và cho thử lại. */
export function ErrorNote({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="grid grid-cols-1 justify-items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 p-3 text-sm">
      <p>{message}</p>
      <button type="button" onClick={onRetry} className={cn("flex h-9 items-center gap-1.5 rounded-full border bg-card px-3 font-medium hover:bg-primary-soft", focusRing)}>
        <RotateCwIcon className="size-3.5" aria-hidden />
        Thử lại
      </button>
    </div>
  );
}

const signed = (value: number) => (value > 0 ? `+${value}` : String(value));

/** Số sao của học viên: sao trong buổi (có dấu) và tổng tích lũy. */
export function Stars({ session, total }: { session?: number | null; total: number | null }) {
  if (total === null) return null;
  return (
    <span className="shrink-0 text-xs tabular-nums">
      {session ? <span className={cn("mr-1.5 font-medium", session > 0 ? "text-primary" : "text-danger")}>{signed(session)}</span> : null}
      <span className="font-semibold text-brand-gold">★ {total}</span>
    </span>
  );
}
