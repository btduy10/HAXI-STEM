import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { StudentStarCard } from "@/components/student-star-card";
import { CrudSection } from "@/components/crud-section";
import type { Field } from "@/components/form-dialog";
import { Badge } from "@/components/ui/badge";
import { LinkButton } from "@/components/link-button";
import { WEEKDAY_LABELS } from "@/lib/dates";
import { LABELS, formatDate, formatTime } from "@/lib/format";
import { createTemplateAction, deleteTemplateAction, updateTemplateAction } from "@/server/actions/schedule";
import { orNotFound, uuidParam } from "@/server/page";
import { listTeachers, listTimeSlots } from "@/server/services/catalog";
import { getClass } from "@/server/services/classes";
import { listTemplates } from "@/server/services/sessions";
import { listClassStars } from "@/server/services/stars";
import { requireMenu } from "@/server/session";

export const metadata: Metadata = { title: "Chi tiết lớp" };

export default async function ClassDetailPage({ params }: PageProps<"/admin/classes/[id]">) {
  const { actor, can } = await requireMenu("classes");
  // Lịch mẫu (cũng là nơi phân công giáo viên) thuộc quyền "Sửa" của menu Lớp học.
  const canEdit = can("edit");
  const classId = uuidParam((await params).id);
  const cls = await orNotFound(getClass(actor, classId));
  // Lớp chỉ hiển thị trên Thời khóa biểu (vd. cho mượn phòng) không có học viên: trang chỉ còn lịch mẫu.
  const tracksStudents = !cls.timetableOnly;
  const [teachers, students, templates, slots] = await Promise.all([
    listTeachers(actor),
    tracksStudents ? listClassStars(actor, classId) : [],
    listTemplates(actor, classId),
    listTimeSlots(actor),
  ]);

  // Giáo viên để chọn: người đang dạy, cộng người đã có tên trong lịch mẫu của lớp (để sửa dòng cũ không mất tên).
  const inTemplates = new Set(templates.flatMap((t) => [t.teacherId, t.assistantTeacherId]));
  const teacherOptions = teachers
    .filter((t) => t.status === "active" || inTemplates.has(t.id))
    .map((t) => ({ value: t.id, label: `${t.code} – ${t.fullName}` }));

  // Không có ô Phòng: buổi của lớp dùng phòng đã chọn khi tạo lớp.
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
    // Phân công nằm ở lịch mẫu: lớp thường phải chọn giáo viên chính (máy chủ kiểm tra lại).
    { name: "teacherId", label: "Giáo viên chính", type: "select", required: tracksStudents, options: teacherOptions },
    { name: "assistantTeacherId", label: "Trợ giảng (nếu có)", type: "select", options: teacherOptions },
  ];

  return (
    <div className="grid gap-6">
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
        title="Lịch mẫu hằng tuần"
        addLabel="Thêm"
        columns={["Thứ", "Ca", "GV chính", "Trợ giảng"]}
        rows={templates.map((t) => ({
          id: t.id,
          cells: [
            WEEKDAY_LABELS[t.weekday] ?? "",
            `${t.slotName} (${formatTime(t.startTime ?? t.slotStart)}–${formatTime(t.endTime ?? t.slotEnd)})`,
            t.teacherName ?? "",
            t.assistantName ?? "",
          ],
          values: {
            weekday: String(t.weekday),
            timeSlotId: t.timeSlotId,
            teacherId: t.teacherId ?? "",
            assistantTeacherId: t.assistantTeacherId ?? "",
          },
        }))}
        fields={templateFields}
        createAction={canEdit ? createTemplateAction.bind(null, classId) : undefined}
        updateAction={canEdit ? updateTemplateAction : undefined}
        deleteAction={canEdit ? deleteTemplateAction : undefined}
        deleteNote="Các buổi chưa dạy của dòng này từ hôm nay đến hết tuần sau cũng bị bỏ khỏi Thời khóa biểu."
        emptyText="Chưa có lịch mẫu. Thêm các buổi học trong tuần của lớp; Thời khóa biểu tự có buổi từ hôm nay đến hết tuần sau."
      />
      <p className="-mt-3 text-sm text-muted-foreground">
        Thêm, sửa, xóa dòng lịch mẫu là các buổi chưa dạy của lớp từ hôm nay đến hết tuần sau tự xếp theo
        {cls.roomName ? `, tại ${cls.roomName}` : ""}; buổi đã điểm danh, đã hủy, đã dời hoặc sửa tay ở Thời khóa biểu giữ nguyên. Các tuần
        sau được bổ sung bởi tác vụ hằng ngày hoặc nút “Sinh lịch tuần sau” ở Thời khóa biểu.
      </p>

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
