"use client";

import { XIcon } from "lucide-react";
import type { CSSProperties } from "react";
import { AttendanceSheet } from "@/components/attendance-sheet";
import { StarPad } from "@/components/star-pad";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { WEEKDAY_LABELS, isoWeekday } from "@/lib/dates";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { centerWorkspaceAction } from "@/server/actions/center";
import { saveAttendanceAction } from "@/server/actions/schedule";
import type { WorkspaceTab } from "./detail-panels";
import { ErrorNote, Skeleton, emptyBox, focusRing } from "./parts";
import { useRemote } from "./use-remote";

/**
 * Ngăn kéo điểm danh và ghi sao một buổi ngay trên dashboard. Bên trong là NGUYÊN hai component của trang Điểm danh và trang
 * Ghi sao (`AttendanceSheet`, `StarPad`), lưu bằng đúng các action hiện có (`saveAttendanceAction`, `awardStarsAction`,
 * `undoStarAction`); ở đây chỉ tải dữ liệu của buổi và đặt chúng vào khung mới.
 */
export function SessionWorkspace({
  sessionId,
  tab,
  version,
  onTab,
  onClose,
  onChanged,
}: {
  sessionId: string;
  tab: WorkspaceTab;
  /** Đổi khi dữ liệu của trang vừa được làm mới: tải lại bảng điểm danh và bảng ghi sao. */
  version: string;
  onTab: (tab: WorkspaceTab) => void;
  onClose: () => void;
  /** Gọi sau khi lưu điểm danh thành công, để các thẻ khác tải lại. */
  onChanged: () => void;
}) {
  const remote = useRemote(sessionId, () => centerWorkspaceAction({ sessionId }), version);
  const data = remote.data;
  const tabs: { key: WorkspaceTab; label: string }[] = [
    ...(!data || data.attendance ? [{ key: "attendance" as const, label: "Điểm danh" }] : []),
    ...(!data || data.stars ? [{ key: "stars" as const, label: "Ghi sao" }] : []),
  ];
  // Người dùng chỉ có một trong hai quyền: luôn mở phần họ xem được.
  const active: WorkspaceTab = data && !data.attendance ? "stars" : data && !data.stars ? "attendance" : tab;
  const stars = data?.stars ?? null;
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" showCloseButton={false} className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl" data-session-workspace>
        <SheetHeader className="gap-2 border-b pr-14">
          <SheetTitle>{data ? `${data.session.classCode} – ${data.session.className}` : "Buổi học"}</SheetTitle>
          <SheetDescription>
            {data
              ? `${WEEKDAY_LABELS[isoWeekday(data.session.date)]}, ${formatDate(data.session.date)} · ${data.session.startTime}–${data.session.endTime}${data.session.roomName ? ` · ${data.session.roomName}` : ""}`
              : "Điểm danh và ghi sao ngay trên trang Tổng quan."}
          </SheetDescription>
          {tabs.length > 1 && (
            <div role="tablist" aria-label="Chọn thao tác" className="flex gap-1 rounded-full bg-primary-soft p-1">
              {tabs.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={active === item.key}
                  onClick={() => onTab(item.key)}
                  className={cn(
                    "h-9 flex-1 rounded-full px-3 text-sm font-medium transition-colors",
                    focusRing,
                    active === item.key ? "bg-primary text-primary-foreground" : "text-primary-strong hover:bg-card",
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
          <SheetClose aria-label="Đóng" className={cn("absolute top-3 right-3 grid size-9 place-items-center rounded-full border bg-card hover:bg-primary-soft", focusRing)}>
            <XIcon className="size-4" aria-hidden />
          </SheetClose>
        </SheetHeader>

        {/* Hai component gốc có thanh nút cố định ở đáy màn hình: khung này (có transform) giữ thanh đó nằm trong ngăn kéo. */}
        <div className="relative min-h-0 flex-1 [transform:translateZ(0)]" style={{ "--sidebar-w": "0px" } as CSSProperties}>
          <div className="h-full overflow-y-auto p-4">
            {remote.error ? (
              <ErrorNote message={remote.error} onRetry={remote.retry} />
            ) : !data ? (
              <Skeleton rows={5} label="Đang tải buổi học" />
            ) : active === "attendance" && data.attendance ? (
              <AttendanceSheet
                // Nạp lại trạng thái khi máy chủ trả dữ liệu mới (vừa mở khóa, vừa lưu lần đầu).
                key={`${data.attendance.blockedReason ?? "open"}-${data.attendance.recorded}`}
                sessionId={sessionId}
                initialRows={data.attendance.rows}
                initialContent={data.session.content}
                initialRemark={data.attendance.teacherRemark}
                lessons={data.attendance.lessons}
                recorded={data.attendance.recorded}
                blockedReason={data.attendance.blockedReason}
                saveAction={async (input) => {
                  const result = await saveAttendanceAction(input);
                  if (result.ok) onChanged();
                  return result;
                }}
              />
            ) : stars ? (
              stars.blockedReason ? (
                <Alert>
                  <AlertDescription>{stars.blockedReason}</AlertDescription>
                </Alert>
              ) : stars.students.length === 0 ? (
                <p className={emptyBox}>Buổi học không có học viên nào.</p>
              ) : !stars.canAward ? (
                <div className="grid gap-3">
                  <Alert>
                    <AlertDescription>Bạn chỉ có quyền xem sao của buổi này, không có quyền ghi sao.</AlertDescription>
                  </Alert>
                  <ul className="grid gap-1.5">
                    {stars.students.map((s) => (
                      <li key={s.studentId} className="flex items-center justify-between gap-2 rounded-xl border bg-card px-3 py-2 text-sm">
                        <span className="min-w-0 break-words">
                          {s.fullName}{" "}
                          <span className="text-ink-soft">
                            ({s.code}
                            {s.makeup && " · Học bù"})
                          </span>
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums">
                          {s.sessionStars > 0 ? `+${s.sessionStars}` : s.sessionStars} sao buổi này · tổng {s.total}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <StarPad
                  sessionId={sessionId}
                  maxDeduction={stars.maxDeduction}
                  criteria={stars.criteria}
                  students={stars.students.map((s) => ({ studentId: s.studentId, code: s.code, fullName: s.makeup ? `${s.fullName} (Học bù)` : s.fullName, sessionStars: s.sessionStars, total: s.total }))}
                  logs={stars.logs}
                />
              )
            ) : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
