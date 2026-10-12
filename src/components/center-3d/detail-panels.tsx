"use client";

import { ArrowLeftIcon, ClipboardCheckIcon, StarIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { type CenterRoom, type CenterSession, ROOM_STATE_LABELS, type RoomState } from "@/domain/center-3d";
import { WEEKDAY_SHORT, isoWeekday } from "@/lib/dates";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CenterSessionDetail, CenterStudentDetail, CenterTeacherWeek } from "@/server/services/center-detail";
import { ATTENDANCE, Chip, ErrorNote, Skeleton, Stars, emptyBox, focusRing, listRow, sessionState } from "./parts";
import { STATE_DOT } from "./theme";
import type { Remote } from "./use-remote";

// Thẻ chi tiết bên phải của dashboard 3D: danh sách phòng, chi tiết lớp của một buổi, thẻ học viên, thẻ giáo viên.
// Chi tiết (danh sách học viên, sao, lịch sử) chỉ tải khi người dùng mở, qua các hàm đọc đã kiểm tra quyền ở máy chủ.

export type RoomRow = { room: CenterRoom; state: RoomState; session: CenterSession | null };
/** Quyền của người dùng, tính ở máy chủ. Chỉ để ẩn bớt nút và không gọi những gì chắc chắn bị từ chối; máy chủ vẫn kiểm tra lại. */
export type StagePerms = { attendance: boolean; stars: boolean; students: boolean };
export type Person = { kind: "teacher" | "student"; id: string; name: string };
export type WorkspaceTab = "attendance" | "stars";

function Back({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={cn("flex w-fit items-center gap-1 rounded-full text-xs font-medium text-primary hover:underline", focusRing)}>
      <ArrowLeftIcon className="size-3.5" aria-hidden />
      {children}
    </button>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-ink-soft">{label}</dt>
      <dd className="min-w-0 text-right font-medium break-words">{children}</dd>
    </div>
  );
}

/** Danh sách phòng theo trạng thái, và các buổi hôm nay chưa xếp phòng. */
function RoomList({
  today,
  now,
  rooms,
  unplaced,
  onRoom,
  onSession,
}: {
  today: string;
  now: string;
  rooms: RoomRow[];
  unplaced: CenterSession[];
  onRoom: (id: string) => void;
  onSession: (id: string) => void;
}) {
  return (
    <>
      <div>
        <h2 className="text-base leading-tight font-semibold">Phòng học hôm nay</h2>
        <p className="text-sm text-ink-soft">{formatDate(today)} · bấm một phòng để xem lớp đang học</p>
      </div>
      <div className="grid min-h-0 grid-cols-1 content-start gap-3 overflow-y-auto">
        {rooms.length === 0 ? (
          <p className={emptyBox}>Chưa có phòng học nào. Thêm phòng ở Phòng &amp; Ca học.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-1.5">
            {rooms.map(({ room, state, session }) => (
              <li key={room.id}>
                <button
                  type="button"
                  data-room={room.name}
                  data-state={state}
                  onClick={() => onRoom(room.id)}
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
              {unplaced.map((session) => {
                const state = sessionState(session, now);
                return (
                  <li key={session.id}>
                    <button type="button" onClick={() => onSession(session.id)} className={listRow}>
                      <span className="flex items-center justify-between gap-2">
                        <span className="font-semibold tabular-nums">
                          {session.startTime}–{session.endTime}
                        </span>
                        <Chip className={state.className}>{state.label}</Chip>
                      </span>
                      <span className="truncate">{session.className}</span>
                      <span className="truncate text-xs text-ink-soft">{session.teacherName ? `GV: ${session.teacherName}` : "Chưa có giáo viên"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </>
  );
}

/** Chi tiết lớp của một buổi: người dạy, giờ, sĩ số, tỉ lệ điểm danh, danh sách học viên kèm sao, và các nút thao tác. */
function ClassView({
  now,
  row,
  roomSessions,
  session,
  detail,
  perms,
  onBack,
  onSession,
  onTeacher,
  onStudent,
  onWorkspace,
}: {
  now: string;
  /** Phòng của buổi; null khi buổi chưa xếp phòng. */
  row: RoomRow | null;
  /** Các buổi hôm nay của phòng (để đổi qua lại khi phòng có nhiều buổi). */
  roomSessions: CenterSession[];
  session: CenterSession | null;
  detail: Remote<CenterSessionDetail>;
  perms: StagePerms;
  onBack: () => void;
  onSession: (id: string) => void;
  onTeacher: (id: string, name: string) => void;
  onStudent: (id: string, name: string) => void;
  onWorkspace: (tab: WorkspaceTab) => void;
}) {
  const state = session ? sessionState(session, now) : null;
  const info = detail.data;
  const action = cn("flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-medium", focusRing);
  return (
    <>
      <div className="grid gap-2">
        <Back onClick={onBack}>Tất cả phòng</Back>
        <div className="flex items-start justify-between gap-2">
          <h2 className="min-w-0 text-base leading-tight font-semibold break-words">{row ? row.room.name : "Chưa xếp phòng"}</h2>
          {row && (
            <Chip className="bg-primary-soft text-primary-strong">
              <span aria-hidden className={cn("mr-1.5 size-2 rounded-full", STATE_DOT[row.state])} />
              {ROOM_STATE_LABELS[row.state]}
            </Chip>
          )}
        </div>
        {row && (
          <p className="text-sm text-ink-soft">
            Sức chứa {row.room.capacity} chỗ · {roomSessions.length} buổi hôm nay
          </p>
        )}
        {roomSessions.length > 1 && (
          <div role="group" aria-label="Các buổi hôm nay của phòng" className="flex flex-wrap gap-1">
            {roomSessions.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={item.id === session?.id}
                onClick={() => onSession(item.id)}
                className={cn(
                  "h-8 rounded-full border px-2.5 text-xs font-medium tabular-nums",
                  focusRing,
                  item.id === session?.id ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-primary-soft",
                  item.cancelled && "line-through",
                )}
              >
                {item.startTime}–{item.endTime}
              </button>
            ))}
          </div>
        )}
      </div>

      {!session || !state ? (
        <p className={emptyBox}>Hôm nay phòng không có buổi học.</p>
      ) : (
        <div className="grid min-h-0 grid-cols-1 content-start gap-3 overflow-y-auto" aria-live="polite">
          <div className="grid grid-cols-1 gap-2 rounded-xl border bg-background/70 p-3 text-sm" data-class-detail={session.className}>
            <div className="flex items-start justify-between gap-2">
              <h3 className="min-w-0 font-semibold break-words">{session.className}</h3>
              <Chip className={state.className}>{state.label}</Chip>
            </div>
            <dl className="grid grid-cols-1 gap-1">
              <Fact label="Giáo viên">
                {session.teacherId && session.teacherName ? (
                  <button type="button" onClick={() => onTeacher(session.teacherId!, session.teacherName!)} className={cn("rounded text-primary underline-offset-2 hover:underline", focusRing)}>
                    {info?.teacherName ?? session.teacherName}
                  </button>
                ) : (
                  "Chưa có giáo viên"
                )}
                {info?.replacedTeacherName && <span className="block text-xs font-normal text-ink-soft">dạy thay {info.replacedTeacherName}</span>}
              </Fact>
              {info?.assistantName && <Fact label="Trợ giảng">{info.assistantName}</Fact>}
              <Fact label="Giờ học">
                <span className="tabular-nums">
                  {session.startTime}–{session.endTime}
                </span>
              </Fact>
              {session.studentCount !== null && (
                <Fact label="Sĩ số">
                  <span className="tabular-nums">
                    {info ? info.enrolled : session.studentCount}
                    {row && `/${row.room.capacity}`}
                  </span>
                </Fact>
              )}
              {!session.timetableOnly && (
                <Fact label="Tỉ lệ điểm danh">
                  {info ? (
                    info.rate === null ? (
                      <span className="font-normal text-ink-soft">Chưa điểm danh</span>
                    ) : (
                      <span className="tabular-nums" data-attendance-rate>
                        {info.rate}% <span className="font-normal text-ink-soft">({info.attended}/{info.marked} có đi học)</span>
                      </span>
                    )
                  ) : (
                    <span className="font-normal text-ink-soft">{session.attendanceCount > 0 ? "Đã điểm danh" : "Chưa điểm danh"}</span>
                  )}
                </Fact>
              )}
            </dl>
            {!session.timetableOnly && (
              <div className="flex flex-wrap gap-1.5">
                {perms.attendance && (
                  <button type="button" onClick={() => onWorkspace("attendance")} className={cn(action, "bg-primary text-primary-foreground hover:bg-primary-strong")}>
                    <ClipboardCheckIcon className="size-4" aria-hidden />
                    Điểm danh
                  </button>
                )}
                {perms.stars && (
                  <button type="button" onClick={() => onWorkspace("stars")} className={cn(action, "border bg-card hover:bg-brand-gold-soft")}>
                    <StarIcon className="size-4 text-brand-gold" aria-hidden />
                    Ghi sao
                  </button>
                )}
              </div>
            )}
            {session.href && (
              <Link href={session.href} className={cn("w-fit rounded font-medium text-primary underline-offset-2 hover:underline", focusRing)}>
                Mở buổi học
              </Link>
            )}
          </div>

          {session.timetableOnly ? (
            <p className={emptyBox}>Buổi này chỉ giữ phòng trên Thời khóa biểu, không có học viên.</p>
          ) : !perms.attendance ? (
            <p className={emptyBox}>Bạn không có quyền xem danh sách học viên của buổi.</p>
          ) : detail.error ? (
            <ErrorNote message={detail.error} onRetry={detail.retry} />
          ) : !info ? (
            <Skeleton label="Đang tải danh sách học viên" />
          ) : (
            <div className="grid grid-cols-1 gap-1.5">
              <h3 className="text-sm font-medium">Học viên ({info.students.length})</h3>
              {info.students.length === 0 ? (
                <p className={emptyBox}>Buổi học không có học viên nào.</p>
              ) : (
                <ul className="grid grid-cols-1 gap-1">
                  {info.students.map((student) => {
                    const mark = student.status ? ATTENDANCE[student.status] : null;
                    const body = (
                      <span className="flex items-center gap-2.5">
                        <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", mark ? mark.dot : "border border-ink-soft/50")} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{student.fullName}</span>
                          <span className="block truncate text-xs text-ink-soft">
                            {student.code}
                            {student.makeup && " · Học bù"} · {mark ? mark.label : "Chưa điểm danh"}
                          </span>
                        </span>
                        <Stars session={student.sessionStars} total={student.total} />
                      </span>
                    );
                    return (
                      <li key={student.studentId} data-student={student.fullName}>
                        {perms.students ? (
                          <button type="button" onClick={() => onStudent(student.studentId, student.fullName)} className={listRow}>
                            {body}
                          </button>
                        ) : (
                          <div className={cn(listRow, "hover:bg-background/70")}>{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Thẻ học viên: mã, lớp đang học, tổng sao và lịch sử điểm danh gần nhất. */
function StudentView({
  person,
  detail,
  href,
  onBack,
  backLabel,
}: {
  person: Person;
  detail: Remote<CenterStudentDetail>;
  /** Trang hồ sơ đầy đủ của học viên. */
  href: string;
  onBack: () => void;
  backLabel: string;
}) {
  const info = detail.data;
  return (
    <>
      <div className="grid gap-2">
        <Back onClick={onBack}>{backLabel}</Back>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-base leading-tight font-semibold break-words">{info?.fullName ?? person.name}</h2>
            <p className="text-sm text-ink-soft">
              Học viên{info && ` · ${info.code}`}
              {info && info.classes.length > 0 && ` · ${info.classes.map((c) => c.name).join(", ")}`}
            </p>
          </div>
          {info && info.total !== null && (
            <p className="shrink-0 text-right leading-none" data-student-total>
              <span className="block text-2xl font-semibold text-brand-gold tabular-nums">★ {info.total}</span>
              <span className="text-xs text-ink-soft">tổng sao</span>
            </p>
          )}
        </div>
      </div>
      {detail.error ? (
        <ErrorNote message={detail.error} onRetry={detail.retry} />
      ) : !info ? (
        <Skeleton label="Đang tải thông tin học viên" />
      ) : (
        <div className="grid min-h-0 grid-cols-1 content-start gap-2 overflow-y-auto">
          <h3 className="text-sm font-medium">Lịch sử điểm danh</h3>
          {info.attendance.length === 0 ? (
            <p className={emptyBox}>Chưa có lượt điểm danh nào.</p>
          ) : (
            <ul className="grid grid-cols-1 gap-1">
              {info.attendance.map((item) => {
                const mark = ATTENDANCE[item.status];
                return (
                  <li key={item.sessionId} className="flex items-center gap-2.5 rounded-xl border bg-background/70 px-3 py-2 text-sm">
                    <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", mark.dot)} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{mark.label}</span>
                      <span className="block truncate text-xs text-ink-soft tabular-nums">
                        {formatDate(item.date)} · {item.startTime} · {item.classCode}
                      </span>
                    </span>
                    {item.stars !== null && item.stars !== 0 && (
                      <span className={cn("shrink-0 text-xs font-semibold tabular-nums", item.stars > 0 ? "text-primary" : "text-danger")}>
                        {item.stars > 0 ? `+${item.stars}` : item.stars} sao
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <Link href={href} className={cn("w-fit rounded text-sm font-medium text-primary underline-offset-2 hover:underline", focusRing)}>
            Mở hồ sơ đầy đủ
          </Link>
        </div>
      )}
    </>
  );
}

const ROLE_LABELS = { main: "Dạy chính", substitute: "Dạy thay", assistant: "Trợ giảng", replaced: "Có người dạy thay" } as const;

/** Thẻ giáo viên: các lớp và buổi phụ trách trong tuần này. Buổi của hôm nay bấm được để mở lớp. */
function TeacherView({
  person,
  detail,
  today,
  todayIds,
  onBack,
  backLabel,
  onSession,
}: {
  person: Person;
  detail: Remote<CenterTeacherWeek>;
  today: string;
  /** Các buổi hôm nay đang có trên dashboard (bấm được). */
  todayIds: Set<string>;
  onBack: () => void;
  backLabel: string;
  onSession: (id: string) => void;
}) {
  const info = detail.data;
  return (
    <>
      <div className="grid gap-2">
        <Back onClick={onBack}>{backLabel}</Back>
        <div>
          <h2 className="text-base leading-tight font-semibold break-words">{person.name}</h2>
          <p className="text-sm text-ink-soft">
            Giáo viên
            {info && ` · tuần ${formatDate(info.from)}–${formatDate(info.to)}: ${info.total} buổi, ${info.classes.length} lớp`}
          </p>
        </div>
      </div>
      {detail.error ? (
        <ErrorNote message={detail.error} onRetry={detail.retry} />
      ) : !info ? (
        <Skeleton label="Đang tải lịch dạy trong tuần" />
      ) : info.classes.length === 0 ? (
        <p className={emptyBox}>Tuần này giáo viên không có buổi nào trong phạm vi bạn được xem.</p>
      ) : (
        <ul className="grid min-h-0 grid-cols-1 content-start gap-2.5 overflow-y-auto">
          {info.classes.map((group) => (
            <li key={group.classId} className="grid grid-cols-1 gap-1" data-teacher-class={group.className}>
              <h3 className="text-sm font-medium break-words">
                {group.className} <span className="font-normal text-ink-soft">· {group.sessions.length} buổi</span>
              </h3>
              <ul className="grid grid-cols-1 gap-1">
                {group.sessions.map((item) => {
                  const body = (
                    <span className="flex items-center justify-between gap-2">
                      <span className="min-w-0">
                        <span className={cn("block font-medium tabular-nums", item.status === "cancelled" && "line-through")}>
                          {WEEKDAY_SHORT[isoWeekday(item.date)]} {formatDate(item.date).slice(0, 5)} · {item.startTime}–{item.endTime}
                        </span>
                        <span className="block truncate text-xs text-ink-soft">
                          {[item.roomName ?? "Chưa xếp phòng", ROLE_LABELS[item.role]].join(" · ")}
                        </span>
                      </span>
                      <Chip className={item.status === "done" ? "bg-state-done/45 text-primary-strong" : item.status === "cancelled" ? "bg-muted text-ink-soft" : item.date === today ? "bg-primary-soft text-primary-strong" : "bg-brand-gold-soft text-foreground"}>
                        {item.status === "done" ? "Đã điểm danh" : item.status === "cancelled" ? "Đã hủy" : item.date === today ? "Hôm nay" : item.date < today ? "Chưa điểm danh" : "Sắp tới"}
                      </Chip>
                    </span>
                  );
                  return (
                    <li key={item.id}>
                      {todayIds.has(item.id) ? (
                        <button type="button" onClick={() => onSession(item.id)} className={listRow}>
                          {body}
                        </button>
                      ) : (
                        <div className={cn(listRow, "hover:bg-background/70")}>{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Thẻ chi tiết bên phải. Theo thứ tự ưu tiên: học viên hoặc giáo viên đang chọn → lớp của buổi đang chọn → phòng đang chọn
 * (không có buổi) → danh sách phòng.
 */
export function DetailPanel({
  className,
  today,
  now,
  rooms,
  sessionsOf,
  unplaced,
  room,
  session,
  person,
  sessionDetail,
  studentDetail,
  teacherDetail,
  perms,
  studentHref,
  todayIds,
  onRoom,
  onSession,
  onTeacher,
  onStudent,
  onClosePerson,
  onWorkspace,
}: {
  className?: string;
  today: string;
  now: string;
  rooms: RoomRow[];
  sessionsOf: Map<string, CenterSession[]>;
  unplaced: CenterSession[];
  room: RoomRow | null;
  session: CenterSession | null;
  person: Person | null;
  sessionDetail: Remote<CenterSessionDetail>;
  studentDetail: Remote<CenterStudentDetail>;
  teacherDetail: Remote<CenterTeacherWeek>;
  perms: StagePerms;
  studentHref: (id: string) => string;
  todayIds: Set<string>;
  onRoom: (id: string | null) => void;
  onSession: (id: string) => void;
  onTeacher: (id: string, name: string) => void;
  onStudent: (id: string, name: string) => void;
  onClosePerson: () => void;
  onWorkspace: (tab: WorkspaceTab) => void;
}) {
  const backLabel = session ? `Quay lại ${session.className}` : "Tất cả phòng";
  const roomSessions = room ? [...(sessionsOf.get(room.room.id) ?? [])].sort((a, b) => a.startTime.localeCompare(b.startTime)) : [];
  const label = person?.kind === "student" ? "Chi tiết học viên" : person?.kind === "teacher" ? "Chi tiết giáo viên" : room || session ? "Chi tiết lớp học" : "Phòng học hôm nay";
  return (
    <section aria-label={label} data-detail-panel className={cn("panel flex min-h-0 flex-col gap-3 p-3.5", className)}>
      {person?.kind === "student" ? (
        <StudentView person={person} detail={studentDetail} href={studentHref(person.id)} onBack={onClosePerson} backLabel={backLabel} />
      ) : person?.kind === "teacher" ? (
        <TeacherView person={person} detail={teacherDetail} today={today} todayIds={todayIds} onBack={onClosePerson} backLabel={backLabel} onSession={onSession} />
      ) : room || session ? (
        <ClassView
          now={now}
          row={room}
          roomSessions={roomSessions}
          session={session}
          detail={sessionDetail}
          perms={perms}
          onBack={() => onRoom(null)}
          onSession={onSession}
          onTeacher={onTeacher}
          onStudent={onStudent}
          onWorkspace={onWorkspace}
        />
      ) : (
        <RoomList today={today} now={now} rooms={rooms} unplaced={unplaced} onRoom={onRoom} onSession={onSession} />
      )}
    </section>
  );
}
