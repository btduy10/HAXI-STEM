import type { Metadata } from "next";
import { CrudSection } from "@/components/crud-section";
import { Button } from "@/components/ui/button";
import { LinkButton } from "@/components/link-button";
import { Input } from "@/components/ui/input";
import { LABELS, formatDate } from "@/lib/format";
import { studentFields } from "@/lib/student-fields";
import { deleteStudentAction, updateStudentAction } from "@/server/actions/admin";
import { seesStudentPrivate } from "@/server/guard";
import { listStudentsPageWithStars } from "@/server/services/student-history";
import { requireMenu } from "@/server/session";

export const metadata: Metadata = { title: "QL Học viên" };

export default async function StudentsPage({ searchParams }: PageProps<"/admin/students">) {
  const { actor, role, can } = await requireMenu("students");
  const admin = role === "admin";
  // Trang này để xem và sửa; học viên mới nhập ở Ghi danh. Thông tin cá nhân chỉ hiện với người được phép xem.
  const privateInfo = seesStudentPrivate(actor);
  const formFields = studentFields({ privateInfo });
  const columns = ["Mã HV", "Họ tên", ...(privateInfo ? ["Ngày sinh"] : []), "Khối", ...(privateInfo ? ["Phụ huynh", "Điện thoại"] : []), "Sao", "Trạng thái"];
  const raw = (await searchParams).q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.slice(0, 100) ?? "";
  const rawPage = (await searchParams).page;
  const { rows: students, total, page, pageCount, pageSize } = await listStudentsPageWithStars(
    actor,
    q,
    Number(Array.isArray(rawPage) ? rawPage[0] : rawPage),
  );
  const pageHref = (n: number) => {
    const query = new URLSearchParams();
    if (q) query.set("q", q);
    if (n > 1) query.set("page", String(n));
    const text = query.toString();
    return text ? `/admin/students?${text}` : "/admin/students";
  };

  return (
    <div className="grid gap-4">
      <form className="flex gap-2" role="search">
        <Input name="q" defaultValue={q} placeholder="Tìm theo tên hoặc mã…" aria-label="Tìm học viên" className="h-10" />
        <Button type="submit" variant="outline" className="h-10">
          Tìm
        </Button>
      </form>
      <CrudSection
        title="Học viên"
        numbered
        centered={["Khối", "Sao"]}
        startIndex={(page - 1) * pageSize}
        total={total}
        footer={
          pageCount > 1 && (
            <nav aria-label="Phân trang học viên" className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted-foreground">
                Trang {page}/{pageCount} · {total} học viên
              </p>
              <div className="flex flex-wrap gap-1">
                {page > 1 && (
                  <LinkButton variant="outline" className="h-10" href={pageHref(page - 1)}>
                    ‹ Trước
                  </LinkButton>
                )}
                {Array.from({ length: pageCount }, (_, i) => i + 1)
                  .filter((n) => n === 1 || n === pageCount || Math.abs(n - page) <= 1)
                  .map((n) => (
                    <LinkButton
                      key={n}
                      variant={n === page ? "default" : "outline"}
                      className="h-10 min-w-10"
                      href={pageHref(n)}
                      aria-label={`Trang ${n}`}
                      aria-current={n === page ? "page" : undefined}
                    >
                      {n}
                    </LinkButton>
                  ))}
                {page < pageCount && (
                  <LinkButton variant="outline" className="h-10" href={pageHref(page + 1)}>
                    Sau ›
                  </LinkButton>
                )}
              </div>
            </nav>
          )
        }
        columns={columns}
        rows={students.map((s) => ({
          id: s.id,
          href: `/admin/students/${s.id}`,
          label: s.fullName,
          cells: [
            s.code,
            s.fullName,
            ...(privateInfo ? [formatDate(s.birthDate)] : []),
            s.schoolGrade ? String(s.schoolGrade) : "",
            ...(privateInfo ? [s.guardianName ?? "", s.phone ?? ""] : []),
            String(s.stars),
            LABELS.studentStatus[s.status],
          ],
          values: {
            code: s.code,
            fullName: s.fullName,
            birthDate: s.birthDate ?? "",
            gender: s.gender ?? "",
            schoolGrade: s.schoolGrade ? String(s.schoolGrade) : "",
            guardianName: s.guardianName ?? "",
            phone: s.phone ?? "",
            status: s.status,
            note: s.note ?? "",
          },
        }))}
        fields={formFields}
        updateAction={can("edit") ? updateStudentAction : undefined}
        deleteAction={admin ? deleteStudentAction : undefined}
        deleteNote="Em phải rời hết các lớp trước. Các lượt ghi danh cũ, điểm danh và sao của em cũng bị xóa."
        detailLabel="Hồ sơ"
        emptyText={q ? "Không tìm thấy học viên phù hợp." : "Chưa có học viên."}
      />
    </div>
  );
}
