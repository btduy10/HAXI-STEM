import type { Metadata } from "next";
import { AutoSubmitSelect } from "@/components/auto-submit-select";
import { CrudSection } from "@/components/crud-section";
import type { Field } from "@/components/form-dialog";
import { LinkButton } from "@/components/link-button";
import { LABELS } from "@/lib/format";
import { createSyllabusLessonAction, deleteSyllabusLessonAction, updateSyllabusLessonAction } from "@/server/actions/admin";
import { listClasses } from "@/server/services/classes";
import { listSyllabus } from "@/server/services/syllabus";
import { requireMenu } from "@/server/session";

export const metadata: Metadata = { title: "Syllabus" };

export default async function SyllabusPage({ searchParams }: PageProps<"/admin/syllabus">) {
  const { actor, can } = await requireMenu("syllabus");
  const classes = await listClasses(actor);
  const params = await searchParams;
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  // Khóa học của các lớp trong phạm vi người xem, theo tên.
  const courses = [...new Map(classes.map((c) => [c.courseId, { id: c.courseId, name: c.courseName }])).values()].sort((a, b) => a.name.localeCompare(b.name, "vi"));
  // Chỉ nhận khóa và lớp có trong danh sách (tránh truy vấn với giá trị tùy ý); lớp phải thuộc khóa đang lọc.
  const course = courses.find((c) => c.id === first(params.courseId)) ?? null;
  const shown = course ? classes.filter((c) => c.courseId === course.id) : classes;
  const current = shown.find((c) => c.id === first(params.classId)) ?? null;
  const lessons = await listSyllabus(actor, { courseId: course?.id, classId: current?.id });

  const period: Field = { name: "period", label: "Buổi", type: "number", required: true, hint: "Buổi thứ mấy của lớp (1, 2, 3…)." };
  const title: Field = { name: "title", label: "Tên bài/Chủ đề", required: true, hint: "Giáo viên chọn tên bài này khi điểm danh; hồ sơ học viên hiện bài em đã học." };
  const product: Field = { name: "product", label: "Sản phẩm", hint: "Sản phẩm học viên làm ra trong buổi (để trống được)." };
  const fields: Field[] = [
    {
      name: "courseId",
      label: "Khóa học",
      type: "select",
      required: true,
      defaultValue: (current?.courseId ?? course?.id) || undefined,
      options: courses.map((c) => ({ value: c.id, label: c.name })),
    },
    {
      name: "classId",
      label: "Lớp học",
      type: "select",
      required: true,
      filterBy: "courseId",
      defaultValue: current?.id,
      options: classes.map((c) => ({ value: c.id, label: `${c.code} – ${c.name}`, group: c.courseId })),
    },
    period,
    title,
    product,
  ];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        {/* Chọn khóa hoặc lớp là lọc ngay. */}
        <form className="grid w-full min-w-0 gap-2 sm:max-w-xl sm:flex-1 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">
            Khóa học
            <AutoSubmitSelect name="courseId" defaultValue={course?.id ?? ""}>
              <option value="">Tất cả khóa</option>
              {courses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </AutoSubmitSelect>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Lớp học
            <AutoSubmitSelect name="classId" defaultValue={current?.id ?? ""}>
              <option value="">Tất cả lớp</option>
              {shown.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} – {c.name} ({LABELS.classStatus[c.status]})
                </option>
              ))}
            </AutoSubmitSelect>
          </label>
        </form>
        {can("add") && (
          <div className="flex flex-wrap gap-2">
            {/* Tải tệp: dùng thẻ <a> thường để trình duyệt tự tải về, không qua router. */}
            <a href="/api/import/syllabus" download className="inline-flex h-10 items-center rounded-full border bg-white/80 px-4 text-sm font-medium hover:bg-muted">
              Tải tệp mẫu
            </a>
            <LinkButton variant="outline" className="h-10" href="/admin/syllabus/import">
              Nhập Excel
            </LinkButton>
          </div>
        )}
      </div>
      <CrudSection
        title="Syllabus"
        numbered
        centered={["Buổi"]}
        columns={["Khóa học", "Lớp học", "Buổi", "Tên bài/Chủ đề", "Sản phẩm"]}
        emptyText="Chưa có bài học nào. Thêm từng bài hoặc nhập từ Excel."
        rows={lessons.map((l) => ({
          id: l.id,
          label: `${l.classCode} · Buổi ${l.period}`,
          cells: [l.courseName, `${l.classCode} – ${l.className}`, String(l.period), l.title, l.product ?? ""],
          values: { period: String(l.period), title: l.title, product: l.product ?? "" },
        }))}
        fields={fields}
        // Sửa: đổi buổi, tên bài, sản phẩm; khóa và lớp của bài giữ nguyên.
        editFields={[period, title, product]}
        createAction={can("add") ? createSyllabusLessonAction : undefined}
        updateAction={can("edit") ? updateSyllabusLessonAction : undefined}
        deleteAction={can("delete") ? deleteSyllabusLessonAction : undefined}
      />
    </div>
  );
}
