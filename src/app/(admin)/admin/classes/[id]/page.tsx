import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { StudentStarCard } from "@/components/student-star-card";
import { CrudSection } from "@/components/crud-section";
import type { Field } from "@/components/form-dialog";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/link-button";
import { GenerateSessionsButton } from "@/components/generate-sessions-button";
import { WEEKDAY_LABELS, isoWeekday, startOfWeek } from "@/lib/dates";
import { LABELS, formatDate, formatTime, toOptions, todayIso } from "@/lib/format";
import { assignTeacherAction, unassignTeacherAction, updateClassTeacherAction } from "@/server/actions/admin";
import { createTemplateAction, deleteTemplateAction, updateTemplateAction } from "@/server/actions/schedule";
import { orNotFound, uuidParam } from "@/server/page";
import { listRooms, listTeachers, listTimeSlots } from "@/server/services/catalog";
import { getClass, listClassTeachers } from "@/server/services/classes";
import { classScheduleOverview, listTemplates, nextSessionDate } from "@/server/services/sessions";
import { listClassStars } from "@/server/services/stars";
import { requireMenu } from "@/server/session";

export const metadata: Metadata = { title: "Chi tiết lớp" };

export default async function ClassDetailPage({ params }: PageProps<"/admin/classes/[id]">) {
  const { actor, can } = await requireMenu("classes");
  // Phân công giáo viên, lịch mẫu và sinh buổi đều thuộc quyền "Sửa" của menu Lớp học.
  const canEdit = can("edit");
  const classId = uuidParam((await params).id);
  const cls = await orNotFound(getClass(actor, classId));
  // Lớp chỉ hiển thị trên Thời khóa biểu (vd. cho mượn phòng) không có học viên: trang chỉ còn giáo viên, lịch mẫu, buổi học.
  const tracksStudents = !cls.timetableOnly;
  const [assigned, teachers, students, templates, slots, rooms] = await Promise.all([
    listClassTeachers(actor, classId),
    listTeachers(actor),
    tracksStudents ? listClassStars(actor, classId) : [],
    listTemplates(actor, classId),
    listTimeSlots(actor),
    listRooms(actor),
  ]);

  // "Xem thời khóa biểu lớp" mở tuần hiện tại nếu lớp có buổi trong tuần này; nếu không thì tuần có buổi sắp tới. Lọc theo lớp.
  const [timetableDate, overview] = await Promise.all([
    can("view", "timetable") ? nextSessionDate(actor, classId, startOfWeek(todayIso())) : null,
    classScheduleOverview(actor, classId),
  ]);
  const timetableHref = `/admin/timetable?${new URLSearchParams({ view: "week", classId, ...(timetableDate ? { date: timetableDate } : {}) })}`;

  const assignedIds = new Set(assigned.map((a) => a.teacherId));
  // Mức lương không đặt ở đây: xem Chấm công → Mức lương giáo viên/Nhân viên.
  const roleFields: Field[] = [
    { name: "role", label: "Vai trò", type: "select", required: true, options: toOptions(LABELS.classTeacherRole), defaultValue: "main" },
  ];
  const teacherFields: Field[] = [
    {
      name: "teacherId",
      label: "Giáo viên",
      type: "select",
      required: true,
      options: teachers
        .filter((t) => t.status === "active" && !assignedIds.has(t.id))
        .map((t) => ({ value: t.id, label: `${t.code} – ${t.fullName}` })),
    },
    ...roleFields,
  ];
  const assignedOf = (role: "main" | "assistant") =>
    assigned.filter((a) => a.role === role).map((a) => ({ value: a.teacherId, label: `${a.code} – ${a.fullName}` }));

  const templateFields: Field[] = [
    {
      name: "weekday",
      label: "Thứ",
      type: "select",
      required: true,
      options: Object.entries(WEEKDAY_LABELS).map(([value, label]) => ({ value, label })),
    },
    {
      name: "timeSlotId",
      label: "Ca học",
      type: "select",
      required: true,
      options: slots.map((s) => ({ value: s.id, label: `${s.name} (${formatTime(s.defaultStart)}–${formatTime(s.defaultEnd)})` })),
    },
    {
      name: "roomId",
      label: "Phòng",
      type: "select",
      options: rooms.map((r) => ({ value: r.id, label: `${r.name} (${r.capacity} chỗ)` })),
      hint: "Không chọn = phòng mặc định của lớp.",
    },
    {
      name: "teacherId",
      label: "Giáo viên chính",
      type: "select",
      options: assignedOf("main"),
      hint: "Không chọn = GV chính đầu tiên của lớp. Chỉ liệt kê GV đã phân công vai trò GV chính.",
    },
    {
      name: "assistantTeacherId",
      label: "Trợ giảng (nếu có)",
      type: "select",
      options: assignedOf("assistant"),
      hint: "Chỉ liệt kê GV đã phân công vai trò Trợ giảng.",
    },
  ];

  return (    <div className="grid gap-6">
      <div className="grid gap-2">
        <BackLink href="/admin/classes">Danh sách lớp</BackLink>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">
            {cls.code} – {cls.name}
          </h1>
          <Badge variant={cls.status === "open" ? "secondary" : "outline"}>{LABELS.classStatus[cls.status]}</Badge>
          {!tracksStudents && <Badge variant="outline">Chỉ hiển thị trên Thời khóa biểu</Badge>}
        </div>
        {!tracksStudents && (
          <p className="text-sm text-muted-foreground">
            Lớp này chỉ để giữ lịch trên Thời khóa biểu và kiểm tra trùng phòng; không có ghi danh, điểm danh, sao, học phí hay chấm công.
          </p>
        )}
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Phòng mặc định:</dt>
            <dd>{cls.roomName ?? "Chưa chọn"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Thời gian:</dt>
            <dd>
              {formatDate(cls.startDate)} – {formatDate(cls.endDate)}
            </dd>
          </div>
          {tracksStudents && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Sĩ số:</dt>
              <dd>
                {students.length}/{cls.maxSize}
              </dd>
            </div>
          )}
        </dl>
      </div>

      <CrudSection
        title="Giáo viên phụ trách"
        addLabel="Phân công"
        columns={["Họ tên", "Mã GV", "Vai trò"]}
        rows={assigned.map((a) => ({
          id: a.id,
          cells: [a.fullName, a.code, LABELS.classTeacherRole[a.role]],
          values: { role: a.role },
        }))}
        fields={teacherFields}
        editFields={roleFields}
        createAction={canEdit ? assignTeacherAction.bind(null, classId) : undefined}
        updateAction={canEdit ? updateClassTeacherAction : undefined}
        deleteAction={canEdit ? unassignTeacherAction : undefined}
        emptyText="Chưa phân công giáo viên."
      />

      <CrudSection
        title="Lịch mẫu hằng tuần"
        addLabel="Thêm"
        columns={["Thứ", "Ca", "Phòng", "GV chính", "Trợ giảng"]}
        rows={templates.map((t) => ({
          id: t.id,
          cells: [
            WEEKDAY_LABELS[t.weekday] ?? "",
            `${t.slotName} (${formatTime(t.startTime ?? t.slotStart)}–${formatTime(t.endTime ?? t.slotEnd)})`,
            t.roomName ?? "Phòng mặc định",
            t.teacherName ?? "GV chính của lớp",
            t.assistantName ?? "",
          ],
          values: {
            weekday: String(t.weekday),
            timeSlotId: t.timeSlotId,
            roomId: t.roomId ?? "",
            teacherId: t.teacherId ?? "",
            assistantTeacherId: t.assistantTeacherId ?? "",
          },
        }))}
        fields={templateFields}
        createAction={canEdit ? createTemplateAction.bind(null, classId) : undefined}
        updateAction={canEdit ? updateTemplateAction : undefined}
        deleteAction={canEdit ? deleteTemplateAction : undefined}
        emptyText="Chưa có lịch mẫu. Thêm các buổi học cố định trong tuần, buổi học sẽ tự có trên Thời khóa biểu."
      />

      <section className="grid gap-2">
        <h2 className="text-lg font-semibold">Buổi học</h2>
        <p className="text-sm text-muted-foreground">
          Buổi học được xếp theo lịch mẫu (đúng thứ, ca, phòng, GV chính và trợ giảng) trong thời gian {formatDate(cls.startDate)} –{" "}
          {formatDate(cls.endDate)}, bỏ ngày nghỉ. Lớp học tiếp khóa sau thì dời Ngày kết thúc của lớp rồi sinh thêm buổi. Bấm nút dưới đây để xếp lại toàn bộ buổi chưa dạy theo lịch mẫu
          hiện tại; buổi đã điểm danh, đã ghi sao và buổi đã hủy giữ nguyên.
        </p>
        {overview.scheduled + overview.makeup > 0 ? (
          <div className="grid gap-2 glass-solid rounded-xl border p-3 text-sm">
            <p>
              Đã xếp <strong>{overview.scheduled}</strong> buổi
              {overview.first && overview.last && (
                <>
                  , từ {WEEKDAY_LABELS[isoWeekday(overview.first.date)]} {formatDate(overview.first.date)} đến{" "}
                  {WEEKDAY_LABELS[isoWeekday(overview.last.date)]} {formatDate(overview.last.date)}
                </>
              )}
              . Đã dạy {overview.done} buổi
              {overview.makeup > 0 && ` · ${overview.makeup} buổi bù`}
              {overview.cancelled > 0 && ` · ${overview.cancelled} buổi đã hủy`}.
            </p>
            {tracksStudents && overview.missingTeacher > 0 && (
              <p className="text-destructive">
                {overview.missingTeacher} buổi chưa có giáo viên. Hãy phân công GV chính cho lớp hoặc chọn GV trong lịch mẫu, rồi bấm “Sinh buổi học từ
                lịch mẫu”.
              </p>
            )}
          </div>
        ) : (
          <p className="rounded-2xl border border-dashed p-3 text-sm text-muted-foreground">Lớp chưa có buổi học nào. Thêm lịch mẫu rồi bấm “Sinh buổi học từ lịch mẫu”.</p>
        )}
        <div className="flex flex-wrap items-start gap-2">
          {canEdit && (
            <GenerateSessionsButton
              classId={classId}
              disabled={templates.length === 0 || cls.status !== "open"}
            />
          )}
          {can("view", "timetable") && (
            <LinkButton variant="outline" className="h-10" href={timetableHref}>
              Xem thời khóa biểu lớp
            </LinkButton>
          )}
          {cls.status === "open" && can("add", "timetable") && (
            <LinkButton variant="outline" className="h-10" href={`/admin/sessions/makeup?classId=${classId}`}>
              Thêm buổi bù
            </LinkButton>
          )}
        </div>
      </section>

      {tracksStudents && (
        <section className="grid gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">
              Học viên đang học <span className="text-sm font-normal text-muted-foreground">({students.length})</span>
            </h2>
            {can("view", "enrollments") && (
              <LinkButton variant="outline" className="h-10" href={`/admin/enrollments?classId=${classId}`}>
                Quản lý ghi danh
              </LinkButton>
            )}
          </div>
          {students.length === 0 ? (
            <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              Chưa có học viên ghi danh.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {students.map((s) => (
                <li key={s.id}>
                  <StudentStarCard fullName={s.fullName} code={s.code} total={s.total} href={can("view", "students") ? `/admin/students/${s.id}` : undefined} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
