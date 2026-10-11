import { BackLink } from "@/components/back-link";
import { ConfirmButton, FormDialogButton } from "@/components/action-buttons";
import { Badge } from "@/components/ui/badge";
import { MAKEUP_STATE_LABELS } from "@/domain/makeup";
import { rosterTime } from "@/domain/roster";
import { WEEKDAY_SHORT, isoWeekday } from "@/lib/dates";
import { LABELS, formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { cancelRedemptionAction, redeemGiftAction } from "@/server/actions/rewards";
import type { Actor } from "@/server/guard";
import { orNotFound } from "@/server/page";
import { getRedemptionInfo } from "@/server/services/redemptions";
import { getStudentStarProfile } from "@/server/services/stars";
import { STUDENT_SCHEDULE_DAYS, getStudentLearningHistory, getStudentSchedule } from "@/server/services/student-history";

/** Hồ sơ học viên: sao, lịch học sắp tới, quà, chương trình đã học và lịch sử buổi học; dùng chung cho Admin và GV (service kiểm tra quyền). */
export async function StudentStarProfile({ actor, studentId, backHref }: { actor: Actor; studentId: string; backHref: string }) {
  const profile = await orNotFound(getStudentStarProfile(actor, studentId));
  const { student } = profile;
  // getStudentStarProfile đã kiểm tra quyền xem học viên này.
  const [redemption, history, schedule] = await Promise.all([
    getRedemptionInfo(actor, studentId),
    getStudentLearningHistory(actor, studentId),
    getStudentSchedule(actor, studentId),
  ]);
  const admin = actor.role === "admin";
  const attended = history.sessions.filter((a) => a.attended).length;

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <div className="grid gap-3">
        <BackLink href={backHref}>Quay lại</BackLink>
        <h1 className="text-xl font-semibold break-words">
          {student.fullName} <span className="text-sm font-normal text-muted-foreground">{student.code}</span>
        </h1>
        <dl className="grid grid-cols-3 gap-2 text-center text-sm">
          {[
            { label: "Tổng sao tích lũy", value: redemption.total },
            { label: "Đã đổi quà", value: redemption.spent },
            { label: "Sao còn lại", value: redemption.balance },
          ].map((item) => (
            <div key={item.label} className="glass-solid rounded-xl border p-2">
              <dt className="text-xs text-muted-foreground">{item.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{item.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <section className="grid gap-2" aria-labelledby="schedule-title">
        <h2 id="schedule-title" className="font-medium">
          Lịch học <span className="text-sm font-normal text-muted-foreground">({STUDENT_SCHEDULE_DAYS} ngày tới)</span>
        </h2>
        {schedule.length === 0 ? (
          <p className="rounded-2xl border border-dashed p-4 text-center text-sm text-muted-foreground">
            Chưa có buổi học nào trong {STUDENT_SCHEDULE_DAYS} ngày tới.
          </p>
        ) : (
          <ul className="grid gap-1.5">
            {schedule.map((s) => (
              <li
                key={s.sessionId}
                data-schedule={s.classCode}
                className="flex flex-wrap items-center justify-between gap-2 glass-solid rounded-xl border px-3 py-2 text-sm"
              >
                <span className="min-w-0">
                  <span className="font-medium">
                    {WEEKDAY_SHORT[isoWeekday(s.date)]} {formatDate(s.date)} · {rosterTime(s.startTime)} – {rosterTime(s.endTime)}
                  </span>
                  <span className="block text-xs break-words text-muted-foreground">
                    Lớp {s.classCode} – {s.className}
                    {s.teacherName && ` · ${s.teacherName}`}
                    {s.roomName && ` · ${s.roomName}`}
                  </span>
                  {s.makeup && (
                    <span className="block text-xs text-muted-foreground">
                      Bù buổi vắng {formatDate(s.absentDate)} · {s.absentClassCode}
                    </span>
                  )}
                </span>
                {/* Học bù: học ghép đã xếp ở Ghi danh. Buổi bù: buổi mở riêng cho lớp. */}
                <Badge variant={s.makeup || s.kind === "makeup" ? "secondary" : "outline"}>
                  {s.makeup ? "Học bù" : s.kind === "makeup" ? "Buổi bù" : "Theo lịch"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Quà</h2>
          {redemption.canRedeem && redemption.options.length > 0 && (
            <FormDialogButton
              label="Đổi quà"
              title={`Đổi quà cho ${student.fullName}`}
              description={`Sao còn lại: ${redemption.balance}. Đổi quà trừ số sao theo mốc quà; tổng sao tích lũy không đổi.`}
              fields={[
                {
                  name: "tierId",
                  label: "Quà",
                  type: "select",
                  required: true,
                  options: redemption.options.map((o) => ({ value: o.tierId, label: `${o.giftName} – ${o.minStars} sao (còn ${o.stock})` })),
                },
              ]}
              fixed={{ studentId }}
              action={redeemGiftAction}
              submitLabel="Đổi quà"
              successMessage="Đã đổi quà."
            />
          )}
        </div>
        {redemption.canRedeem && redemption.options.length === 0 && (
          <p className="text-sm text-muted-foreground">Chưa có quà nào đổi được: chưa đủ sao theo mốc quà, kho hết quà, hoặc lớp chưa có mốc quà.</p>
        )}
        {redemption.history.length > 0 && (
          <ul className="grid gap-1.5">
            {redemption.history.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 glass-solid rounded-xl border px-3 py-2 text-sm">
                <span className="min-w-0">
                  {r.giftName}
                  <span className="block text-xs text-muted-foreground">
                    {r.classCode ? `Lớp ${r.classCode} · ` : ""}đổi lúc {formatDateTime(r.redeemedAt)}
                    {r.redeemedByName ? ` · ${r.redeemedByName}` : ""}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-semibold text-red-600 tabular-nums">−{r.stars} sao</span>
                  {admin && (
                    <ConfirmButton
                      label="Hủy"
                      className="h-9"
                      confirmText={`Hủy lần đổi quà "${r.giftName}"? Học viên được trả lại ${r.stars} sao và kho được cộng lại 1 quà.`}
                      action={cancelRedemptionAction}
                      input={{ id: r.id }}
                      successMessage="Đã hủy lần đổi quà."
                    />
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {profile.gifts.length === 0 ? (
          redemption.history.length === 0 && (
            <p className="rounded-2xl border border-dashed p-4 text-center text-sm text-muted-foreground">Chưa đổi quà.</p>
          )
        ) : (
          <ul className="grid gap-1.5">
            {profile.gifts.map((g) => (
              <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 glass-solid rounded-xl border px-3 py-2 text-sm">
                <span className="min-w-0">
                  {g.giftName} <span className="text-muted-foreground">· quà tổng kết lớp {g.classCode}</span>
                </span>
                <Badge variant={g.status === "given" ? "secondary" : "outline"}>
                  {LABELS.handoverStatus[g.status]}
                  {g.givenAt ? ` ${formatDateTime(g.givenAt)}` : ""}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-2" aria-labelledby="programs-title">
        <h2 id="programs-title" className="font-medium">
          Chương trình đã học
        </h2>
        {history.programs.length === 0 ? (
          <p className="rounded-2xl border border-dashed p-4 text-center text-sm text-muted-foreground">Chưa ghi danh lớp nào.</p>
        ) : (
          <ul className="grid gap-1.5">
            {history.programs.map((p) => (
              <li key={p.enrollmentId} className="flex flex-wrap items-center justify-between gap-2 glass-solid rounded-xl border px-3 py-2 text-sm">
                <span className="min-w-0">
                  <span className="font-medium break-words">{p.courseName}</span>
                  <span className="block text-xs text-muted-foreground">
                    Lớp {p.classCode} – {p.className} · vào lớp {formatDate(p.joinedAt)}
                    {p.leftAt && ` · rời lớp ${formatDate(p.leftAt)}`}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums text-muted-foreground" aria-label={`Có mặt ${p.attended} trên ${p.taught} buổi đã dạy`}>
                    {p.attended}/{p.taught} buổi
                  </span>
                  <Badge variant={p.status === "active" && p.classStatus === "open" ? "secondary" : "outline"}>
                    {p.status === "left" ? LABELS.enrollmentStatus.left : p.classStatus === "closed" ? "Đã học xong" : LABELS.enrollmentStatus.active}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-2" aria-labelledby="sessions-title">
        <h2 id="sessions-title" className="font-medium">
          Lịch sử buổi học{" "}
          <span className="text-sm font-normal text-muted-foreground">
            (có mặt {attended}/{history.sessions.length} buổi đã điểm danh)
          </span>
        </h2>
        {history.sessions.length === 0 ? (
          <p className="rounded-2xl border border-dashed p-4 text-center text-sm text-muted-foreground">Chưa có buổi nào được điểm danh.</p>
        ) : (
          <ul className="grid gap-1.5">
            {history.sessions.map((a) => (
              <li key={a.sessionId} className="flex flex-wrap items-center justify-between gap-2 glass-solid rounded-xl border px-3 py-2 text-sm">
                <span className="min-w-0">
                  {formatDate(a.date)} <span className="text-muted-foreground">· {a.classCode} · {a.courseName}</span>
                  <span className={cn("block break-words", a.lesson ? "font-medium" : "text-xs text-muted-foreground")}>{a.lesson || "Chưa ghi tên bài"}</span>
                </span>
                <span className="flex flex-wrap items-center justify-end gap-2">
                  {a.stars !== null && a.stars !== 0 && (
                    <span className={cn("font-semibold tabular-nums", a.stars > 0 ? "text-emerald-600" : "text-red-600")}>
                      {a.stars > 0 ? `+${a.stars}` : a.stars} sao
                    </span>
                  )}
                  {a.isMakeup && <Badge variant="secondary">Học bù</Badge>}
                  {a.makeup && a.makeup !== "pending" && <Badge variant="outline">{MAKEUP_STATE_LABELS[a.makeup]}</Badge>}
                  <Badge variant={a.status === "absent" || a.status === "excused" ? "outline" : "secondary"}>{LABELS.attendanceStatus[a.status]}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

    </div>
  );
}
