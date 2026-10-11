import type { Metadata } from "next";
import Link from "next/link";
import { ConfirmButton, FormDialogButton } from "@/components/action-buttons";
import { AutoSubmitSelect } from "@/components/auto-submit-select";
import { BackLink } from "@/components/back-link";
import { AssignMakeupButton, MakeupPlanner } from "@/components/makeup-planner";
import { AddStudentButton, RosterEnroll, RosterStudent } from "@/components/roster-enroll";
import { Badge } from "@/components/ui/badge";
import { MAKEUP_AHEAD_DAYS, MAKEUP_LOOKBACK_DAYS, MAKEUP_STATE_LABELS, canAssignMakeup } from "@/domain/makeup";
import { ROSTER_ROWS, rosterTime } from "@/domain/roster";
import { WEEKDAY_SHORT, isoWeekday } from "@/lib/dates";
import { LABELS, formatDate, todayIso } from "@/lib/format";
import { newStudentFields } from "@/lib/student-fields";
import {
  cancelMakeupAction,
  deleteEnrollmentAction,
  enrollNewStudentAction,
  enrollStudentAction,
  leaveEnrollmentAction,
  placeStudentAction,
} from "@/server/actions/admin";
import { seesAllClasses, seesStudentPrivate } from "@/server/guard";
import { listClasses, listEnrollments, weeklyRoster } from "@/server/services/classes";
import { activeClassIdsOf, listMakeupNeeds, listMakeupTargets } from "@/server/services/makeups";
import { listStudents, listWaitingStudents } from "@/server/services/students";
import { requireMenu } from "@/server/session";

export const metadata: Metadata = { title: "Ghi danh" };

export default async function EnrollmentsPage({ searchParams }: PageProps<"/admin/enrollments">) {
  const { actor, role, can } = await requireMenu("enrollments");
  const classes = await listClasses(actor);
  const raw = (await searchParams).classId;
  const requested = Array.isArray(raw) ? raw[0] : raw;
  // Chỉ nhận classId có trong danh sách lớp (tránh truy vấn với giá trị tùy ý).
  const current = classes.find((c) => c.id === requested) ?? null;

  // Chưa chọn lớp: tổng quan các lớp đang học theo buổi trong tuần. Đã chọn lớp: danh sách ghi danh chi tiết của lớp đó.
  // Ghi danh là nơi nhập học viên mới: chỉ cần quyền Thêm của menu này.
  const [enrollments, students, roster, waiting, needs, targets] = await Promise.all([
    current ? listEnrollments(actor, current.id) : [],
    // Học viên có sẵn để chọn khi ghi danh: thẻ "Thêm học viên" ở bảng lớp và nút Ghi danh học viên ở trang chi tiết.
    can("add") ? listStudents(actor) : [],
    current ? null : weeklyRoster(actor),
    current ? [] : listWaitingStudents(actor),
    current ? [] : listMakeupNeeds(actor),
    current || !can("add") ? [] : listMakeupTargets(actor),
  ]);
  const makeupClassIds = await activeClassIdsOf([...new Set(needs.map((n) => n.studentId))]);
  // Form học viên mới: không có ô mã (máy chủ tự cấp); thông tin cá nhân chỉ có khi người dùng được xem.
  const studentForm = newStudentFields(seesStudentPrivate(actor));
  // Nhập em chưa có lớp vào danh sách chờ: chỉ người thấy mọi lớp mới thấy danh sách này.
  const canAddWaiting = can("add") && seesAllClasses(actor);
  // Lớp đang mở còn chỗ, để chọn khi xếp lớp cho em đang chờ.
  const openClasses = classes
    .filter((c) => c.status === "open" && c.studentCount < c.maxSize)
    .map((c) => ({ value: c.id, label: `${c.code} – ${c.name} (còn ${c.maxSize - c.studentCount} chỗ)` }));
  const sessionLabel = (date: string, startTime: string) => `${WEEKDAY_SHORT[isoWeekday(date)]} ${formatDate(date)} · ${rosterTime(startTime)}`;
  const activeIds = new Set(enrollments.filter((e) => e.status === "active").map((e) => e.studentId));
  // Chỉ mã và họ tên được gửi xuống trình duyệt.
  const enrollable = students.filter((s) => s.status !== "left").map((s) => ({ value: s.id, label: `${s.code} – ${s.fullName}` }));
  const candidates = enrollable.filter((s) => !activeIds.has(s.value));
  // Học viên đang học của từng lớp: không cho chọn lại ở thẻ "Thêm học viên".
  const activeByClass = Object.fromEntries((roster?.blocks ?? []).map((b) => [b.classId, b.students.map((s) => s.id)]));
  const today = todayIso();

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        {current && <BackLink href="/admin/enrollments">Tổng quan ghi danh</BackLink>}
        <h1 className="text-xl font-semibold sm:text-2xl">Ghi danh</h1>
      </div>
      <form>
        {/* Chọn lớp là hiện danh sách ngay. Màn hình rộng: ô chọn chỉ chiếm nửa chiều ngang. */}
        <label className="grid gap-1.5 text-sm font-medium sm:w-1/2">
          Lớp học
          <AutoSubmitSelect name="classId" defaultValue={current?.id ?? ""}>
            <option value="">— Chọn lớp —</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} – {c.name} ({c.studentCount}/{c.maxSize})
              </option>
            ))}
          </AutoSubmitSelect>
        </label>
      </form>

      {current && (
        <section className="grid gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              Sĩ số: <strong>{activeIds.size}</strong>/{current.maxSize} · {LABELS.classStatus[current.status]}
            </p>
            {current.status === "open" && can("add") && (
              <FormDialogButton
                label="Ghi danh học viên"
                title={`Ghi danh vào ${current.code}`}
                fields={[
                  {
                    name: "studentId",
                    label: "Học viên",
                    type: "select",
                    required: true,
                    options: candidates,
                  },
                  { name: "joinedAt", label: "Ngày vào lớp", type: "date", required: true },
                ]}
                initial={{ joinedAt: today < current.startDate ? current.startDate : today }}
                action={enrollStudentAction.bind(null, current.id)}
                successMessage="Đã ghi danh."
              />
            )}
          </div>

          {enrollments.length === 0 ? (
            <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              Lớp chưa có học viên.
            </p>
          ) : (
            <ul className="grid gap-2">
              {enrollments.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 glass-solid rounded-xl border p-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium break-words">
                      <span className="tabular-nums">{e.code}</span> <span className="font-normal text-muted-foreground">–</span> {e.fullName}
                    </p>
                    <p className="text-muted-foreground">
                      Vào lớp {formatDate(e.joinedAt)}
                      {e.leftAt && ` · rời lớp ${formatDate(e.leftAt)}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {e.status === "active" && can("edit") ? (
                      <FormDialogButton
                        label="Cho rời lớp"
                        variant="outline"
                        title={`Cho ${e.fullName} rời lớp`}
                        description="Lịch sử điểm danh và sao trước ngày rời lớp được giữ nguyên."
                        fields={[{ name: "leftAt", label: "Ngày rời lớp", type: "date", required: true }]}
                        initial={{ leftAt: today }}
                        fixed={{ id: e.id }}
                        action={leaveEnrollmentAction}
                        successMessage="Đã cập nhật."
                      />
                    ) : (
                      <Badge variant={e.status === "active" ? "secondary" : "outline"}>{LABELS.enrollmentStatus[e.status]}</Badge>
                    )}
                    {/* Ghi danh nhập sai: chỉ Admin xóa hẳn, và chỉ khi lớp còn mở. */}
                    {role === "admin" && current.status === "open" && (
                      <ConfirmButton
                        label="Xóa"
                        variant="destructive"
                        confirmText={`Xóa hẳn ghi danh của ${e.fullName} ở lớp ${current.code}? Điểm danh và lịch sử sao của em ở lớp này trong thời gian ghi danh cũng bị xóa. Không hoàn tác được.`}
                        action={deleteEnrollmentAction}
                        input={{ id: e.id }}
                        successMessage="Đã xóa ghi danh."
                      />
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {roster && (
        <RosterEnroll
          today={today}
          students={enrollable}
          activeByClass={activeByClass}
          newStudentFields={studentForm}
          canLeave={can("edit")}
          canDelete={role === "admin"}
        >
          <p className="text-sm text-muted-foreground">
            Các lớp đang học theo buổi trong tuần (theo Thời khóa biểu tuần này). Bấm tên lớp để xem lịch sử ghi danh.
            {can("add") && " Bấm một hàng “Thêm … học viên” để chọn học viên đã có hoặc nhập học viên mới vào lớp."}
            {can("edit") && " Bấm tên học viên để cho rời lớp."}
          </p>
          {roster.blocks.length === 0 ? (
            <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">Chưa có lớp đang mở nào có buổi học trong tuần hoặc lịch mẫu.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {roster.blocks.map((block) => {
                const rows = Math.max(ROSTER_ROWS, block.students.length);
                // Số chỗ còn lại theo sĩ số tối đa: mỗi chỗ một hàng "Thêm n học viên".
                const free = block.maxSize - block.students.length;
                return (
                  <section
                    key={block.key}
                    data-roster={block.classCode}
                    // Màu theo giáo viên: viền trên và nền tiêu đề; các buổi của cùng một giáo viên cùng tông, đậm nhạt khác nhau.
                    style={{ borderTopColor: block.shade.accent }}
                    className="glass-solid min-w-0 overflow-hidden rounded-2xl border border-t-4 text-sm"
                  >
                    <header style={{ backgroundColor: block.shade.header }} className="grid gap-0.5 border-b px-3 py-2">
                      <div className="flex items-baseline justify-between gap-2">
                        <h2 className="font-semibold">
                          {block.label} - {rosterTime(block.startTime)} - {rosterTime(block.endTime)}
                        </h2>
                        <span className="text-foreground/80 tabular-nums" aria-label={`Sĩ số ${block.students.length} trên ${block.maxSize}`}>
                          {block.students.length}/{block.maxSize}
                        </span>
                      </div>
                      <Link
                        href={`/admin/enrollments?classId=${block.classId}`}
                        className="w-fit max-w-full truncate rounded font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        {block.className}
                        {block.teacherName && ` - ${block.teacherName}`}
                      </Link>
                    </header>
                    <table className="w-full table-fixed">
                      <thead>
                        <tr className="text-xs text-muted-foreground">
                          <th className="w-10 px-1 py-1.5 text-center font-medium">STT</th>
                          <th className="px-2 py-1.5 text-center font-medium">Họ tên HS</th>
                          <th className="w-12 px-1 py-1.5 text-center font-medium">Lớp</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: rows }, (_, index) => {
                          const student = block.students[index];
                          const seat = index - block.students.length + 1;
                          return (
                            <tr key={index} className="h-10 border-t md:h-8">
                              <td className="px-1 text-center text-muted-foreground tabular-nums">{index + 1}</td>
                              {student ? (
                                <>
                                  <td className="truncate px-2" title={student.fullName}>
                                    <RosterStudent enrollmentId={student.enrollmentId} studentName={student.fullName} classCode={block.classCode} />
                                  </td>
                                  <td className="px-1 text-center tabular-nums">{student.schoolGrade ?? ""}</td>
                                </>
                              ) : (
                                <td colSpan={2} className="px-1">
                                  {seat <= free && can("add") && (
                                    <AddStudentButton
                                      classId={block.classId}
                                      classCode={block.classCode}
                                      startDate={block.startDate}
                                      seat={seat}
                                      label={`Thêm ${seat} học viên vào ${block.className}, ${block.label}`}
                                    />
                                  )}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </section>
                );
              })}
            </div>
          )}
          {roster.unscheduled.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Lớp đang mở chưa có buổi học trong tuần và chưa có lịch mẫu (chưa thuộc buổi nào):{" "}
              {roster.unscheduled.map((c, index) => (
                <span key={c.id}>
                  {index > 0 && ", "}
                  <Link href={`/admin/enrollments?classId=${c.id}`} className="text-primary underline-offset-2 hover:underline">
                    {c.code} – {c.name}
                  </Link>
                </span>
              ))}
            </p>
          )}
        </RosterEnroll>
      )}

      {!current && (waiting.length > 0 || canAddWaiting) && (
        <section className="grid gap-2" aria-labelledby="waiting-title">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="waiting-title" className="text-lg font-semibold">
              Chờ lớp <span className="text-sm font-normal text-muted-foreground">({waiting.length})</span>
            </h2>
            {canAddWaiting && (
              <FormDialogButton
                label="Thêm vào danh sách chờ"
                variant="outline"
                title="Thêm học viên chờ lớp"
                description="Nhập học viên mới chưa xếp được lớp; mã học viên tự cấp. Khi có lớp, bấm Xếp lớp hoặc chọn em ở thẻ Thêm học viên của lớp."
                fields={studentForm}
                fixed={{ classId: "none" }}
                action={enrollNewStudentAction}
                successMessage="Đã thêm vào danh sách chờ."
              />
            )}
          </div>
          <p className="text-sm text-muted-foreground">Học viên đang học nhưng chưa thuộc lớp đang mở nào.</p>
          {waiting.length === 0 && (
            <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">Chưa có học viên chờ lớp.</p>
          )}
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {waiting.map((s) => (
              <li key={s.id} data-waiting={s.code} className="flex flex-wrap items-center justify-between gap-2 glass-solid rounded-xl border p-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium break-words">
                    <span className="tabular-nums">{s.code}</span> <span className="font-normal text-muted-foreground">–</span> {s.fullName}
                  </p>
                  <p className="text-muted-foreground">
                    {s.schoolGrade ? `Khối ${s.schoolGrade} · ` : ""}thêm ngày {formatDate(todayIso(s.createdAt))}
                  </p>
                </div>
                {can("add") && (
                  <FormDialogButton
                    label="Xếp lớp"
                    variant="outline"
                    title={`Xếp lớp cho ${s.fullName}`}
                    description={openClasses.length === 0 ? "Chưa có lớp đang mở nào còn chỗ." : undefined}
                    fields={[
                      { name: "classId", label: "Lớp", type: "select", required: true, options: openClasses },
                      { name: "joinedAt", label: "Ngày vào lớp", type: "date", required: true },
                    ]}
                    initial={{ joinedAt: today }}
                    fixed={{ studentId: s.id }}
                    action={placeStudentAction}
                    successMessage="Đã ghi danh."
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!current && needs.length > 0 && (
        <MakeupPlanner
          activeClassIds={makeupClassIds}
          targets={targets.map((t) => ({
            id: t.id,
            classId: t.classId,
            label: `${sessionLabel(t.date, t.startTime)} · ${t.classCode} – ${t.className}${t.teacherName ? ` · ${t.teacherName}` : ""} · ${t.headcount}/${t.maxSize}`,
          }))}
        >
          <section className="grid gap-2" aria-labelledby="makeup-title">
            <h2 id="makeup-title" className="text-lg font-semibold">
              Cần học bù <span className="text-sm font-normal text-muted-foreground">({needs.length})</span>
            </h2>
            <p className="text-sm text-muted-foreground">
              Các buổi học viên vắng trong {MAKEUP_LOOKBACK_DAYS} ngày gần đây chưa được học bù. Xếp bù là cho em học ghép vào một buổi sắp tới
              (trong {MAKEUP_AHEAD_DAYS} ngày) của lớp khác.
            </p>
            <ul className="grid gap-2 lg:grid-cols-2">
              {needs.map((n) => {
                const absentLabel = `${sessionLabel(n.date, n.startTime)} · ${n.classCode}`;
                return (
                  <li
                    key={`${n.absentSessionId}|${n.studentId}`}
                    data-makeup={n.studentCode}
                    className="flex flex-wrap items-center justify-between gap-2 glass-solid rounded-xl border p-3 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="font-medium break-words">
                        <span className="tabular-nums">{n.studentCode}</span> <span className="font-normal text-muted-foreground">–</span> {n.studentName}
                      </p>
                      <p className="text-muted-foreground">
                        {LABELS.attendanceStatus[n.status]} {absentLabel}
                        {n.lesson && ` · ${n.lesson}`}
                      </p>
                      {n.assignmentId && n.makeupDate && n.makeupStartTime && (
                        <p className="text-muted-foreground">
                          Buổi bù: {sessionLabel(n.makeupDate, n.makeupStartTime)} · {n.makeupClassCode}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={n.state === "scheduled" ? "secondary" : "outline"}>{MAKEUP_STATE_LABELS[n.state]}</Badge>
                      {canAssignMakeup(n.state) && can("add") && (
                        <AssignMakeupButton
                          label={n.state === "pending" ? "Xếp bù" : "Xếp lại"}
                          absentSessionId={n.absentSessionId}
                          studentId={n.studentId}
                          studentName={n.studentName}
                          absentLabel={absentLabel}
                        />
                      )}
                      {n.state === "scheduled" && n.assignmentId && can("edit") && (
                        <ConfirmButton
                          label="Hủy xếp bù"
                          confirmText={`Hủy lượt xếp học bù của ${n.studentName}? Buổi vắng quay lại trạng thái chưa xếp bù.`}
                          action={cancelMakeupAction}
                          input={{ id: n.assignmentId }}
                          successMessage="Đã hủy xếp bù."
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </MakeupPlanner>
      )}
    </div>
  );
}
