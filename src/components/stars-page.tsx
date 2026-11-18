import { BackLink } from "@/components/back-link";
import { SessionTabs } from "@/components/session-tabs";
import { StarPad } from "@/components/star-pad";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { WEEKDAY_LABELS, isoWeekday } from "@/lib/dates";
import { formatDate, formatDateTime, formatTime } from "@/lib/format";
import { type Actor, can } from "@/server/guard";
import { orNotFound } from "@/server/page";
import { getSession } from "@/server/services/sessions";
import { getSessionStarBoard } from "@/server/services/stars";

/** Trang ghi sao của một buổi, dùng chung cho Admin và GV; quyền trên buổi do service kiểm tra. */
export async function StarsPage({
  actor,
  sessionId,
  backHref,
  tabQuery,
  area,
}: {
  actor: Actor;
  sessionId: string;
  backHref: string;
  tabQuery?: string;
  area: "admin" | "teacher";
}) {
  const session = await orNotFound(getSession(actor, sessionId));
  // Buổi của lớp chỉ hiển thị trên Thời khóa biểu không có bảng ghi sao: trả 404.
  const board = await orNotFound(getSessionStarBoard(actor, sessionId));

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <div className="grid gap-1">
        <BackLink href={backHref}>Quay lại</BackLink>
        <h1 className="text-xl font-semibold sm:text-2xl">
          Ghi sao {session.classCode} – {session.className}
        </h1>
        <p className="text-sm text-muted-foreground">
          {WEEKDAY_LABELS[isoWeekday(session.date)]}, {formatDate(session.date)} · {formatTime(session.startTime)}–
          {formatTime(session.endTime)}
        </p>
      </div>
      <SessionTabs area={area} sessionId={sessionId} active="stars" query={tabQuery} show={{ attendance: can(actor, "attendance", "view"), stars: true }} />

      {/* Không ghi được (buổi đã hủy, chưa đến ngày, lớp đã đóng…, hoặc chỉ có quyền xem): báo lý do, vẫn xem được sao của buổi. */}
      {board.readOnlyReason && (
        <Alert>
          <AlertDescription>{board.readOnlyReason}</AlertDescription>
        </Alert>
      )}
      {board.students.length === 0 ? (
        <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">Buổi học không có học viên nào.</p>
      ) : board.readOnlyReason ? (
        <ul className="grid gap-1.5">
          {board.students.map((s) => (
            <li key={s.studentId} className="flex items-center justify-between gap-2 glass-solid rounded-xl border px-3 py-2 text-sm">
              <span className="min-w-0 break-words">
                {s.fullName} <span className="text-muted-foreground">({s.code}{s.makeup && " · Học bù"})</span>
              </span>
              <span className="shrink-0 font-semibold tabular-nums">
                {s.sessionStars > 0 ? `+${s.sessionStars}` : s.sessionStars} sao buổi này · tổng {s.total}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <StarPad
          sessionId={sessionId}
          maxDeduction={board.maxDeduction}
          criteria={board.criteria.map((c) => ({ id: c.id, name: c.name, stars: c.stars }))}
          students={board.students.map((s) => ({
            studentId: s.studentId,
            code: s.code,
            fullName: s.makeup ? `${s.fullName} (Học bù)` : s.fullName,
            sessionStars: s.sessionStars,
            total: s.total,
          }))}
          logs={board.logs.map((l) => ({
            id: l.id,
            studentName: l.studentName,
            criteriaName: l.criteriaName,
            stars: l.stars,
            recordedAtLabel: formatDateTime(l.recordedAt),
            isReversal: l.isReversal,
            reversed: l.reversed,
          }))}
        />
      )}
    </div>
  );
}
