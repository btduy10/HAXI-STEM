import { BackLink } from "@/components/back-link";
import { ConfirmButton } from "@/components/action-buttons";
import { AttendanceSheet } from "@/components/attendance-sheet";
import { SessionTabs } from "@/components/session-tabs";
import { SessionBadges } from "@/components/timetable";
import { WEEKDAY_LABELS, isoWeekday } from "@/lib/dates";
import { formatDate, formatTime, todayIso } from "@/lib/format";
import { saveAttendanceAction, unlockAttendanceAction } from "@/server/actions/schedule";
import { type Actor, can, isAdmin } from "@/server/guard";
import { orNotFound } from "@/server/page";
import { getAttendanceSheet } from "@/server/services/attendance";
import { getSession } from "@/server/services/sessions";

/** Trang điểm danh dùng chung cho Admin và GV; quyền trên buổi do service kiểm tra. */
export async function AttendancePage({
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
  // Buổi của lớp chỉ hiển thị trên Thời khóa biểu không có bảng điểm danh: trả 404.
  const sheet = await orNotFound(getAttendanceSheet(actor, sessionId));

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <div className="grid gap-1">
        <BackLink href={backHref}>Quay lại</BackLink>
        <h1 className="text-xl font-semibold sm:text-2xl">
          Điểm danh {session.classCode} – {session.className}
        </h1>
        <p className="text-sm text-muted-foreground">
          {WEEKDAY_LABELS[isoWeekday(session.date)]}, {formatDate(session.date)} · {formatTime(session.startTime)}–
          {formatTime(session.endTime)}
          {session.roomName && ` · ${session.roomName}`}
        </p>
        <div className="flex flex-wrap gap-1">
          <SessionBadges session={session} today={todayIso()} />
        </div>
      </div>

      <SessionTabs area={area} sessionId={sessionId} active="attendance" query={tabQuery} show={{ attendance: true, stars: can(actor, "stars", "view") }} />

      {sheet.locked && isAdmin(actor) && (
        <ConfirmButton
          label="Mở khóa điểm danh 24 giờ"
          confirmText="Mở khóa sửa điểm danh buổi này trong 24 giờ? Thao tác được ghi vào nhật ký."
          action={unlockAttendanceAction}
          input={{ sessionId }}
          successMessage="Đã mở khóa trong 24 giờ."
          className="h-10 w-fit"
        />
      )}

      <AttendanceSheet
        // Nạp lại trạng thái khi máy chủ trả dữ liệu mới (sau khi mở khóa hoặc lưu).
        key={`${sheet.blockedReason ?? "open"}-${sheet.recorded}`}
        sessionId={sessionId}
        initialRows={sheet.rows}
        initialContent={session.content ?? ""}
        initialRemark={sheet.teacherRemark}
        lessons={sheet.lessons}
        recorded={sheet.recorded}
        blockedReason={sheet.readOnlyReason}
        saveAction={saveAttendanceAction}
      />
    </div>
  );
}
