import type { Metadata } from "next";
import { BackLink } from "@/components/back-link";
import { StudentStarCard } from "@/components/student-star-card";
import { Badge } from "@/components/ui/badge";
import { LABELS, formatDate } from "@/lib/format";
import { orNotFound, uuidParam } from "@/server/page";
import { getClass, listClassTeachers } from "@/server/services/classes";
import { listClassStars } from "@/server/services/stars";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Lớp của tôi" };

export default async function TeacherClassPage({ params }: PageProps<"/teacher/classes/[id]">) {
  const { actor } = await requirePageUser("teacher");
  const classId = uuidParam((await params).id);
  // getClass kiểm tra quyền sở hữu lớp; lớp của GV khác trả 404.
  const cls = await orNotFound(getClass(actor, classId));
  const [teachers, students] = await Promise.all([listClassTeachers(actor, classId), listClassStars(actor, classId)]);

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <BackLink href="/teacher/classes">Lớp của tôi</BackLink>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">
            {cls.code} – {cls.name}
          </h1>
          <Badge variant={cls.status === "open" ? "secondary" : "outline"}>{LABELS.classStatus[cls.status]}</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          {cls.roomName && `${cls.roomName} · `}
          {formatDate(cls.startDate)} – {formatDate(cls.endDate)}
        </p>
        <p className="text-sm text-muted-foreground">
          Giáo viên: {teachers.map((t) => `${t.fullName} (${LABELS.classTeacherRole[t.role]})`).join(", ")}
        </p>
      </div>

      <section className="grid gap-2">
        <h2 className="font-medium">
          Học viên <span className="text-sm font-normal text-muted-foreground">({students.length})</span>
        </h2>
        {students.length === 0 ? (
          <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            Lớp chưa có học viên.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {students.map((s) => (
              <li key={s.id}>
                <StudentStarCard fullName={s.fullName} code={s.code} total={s.total} href={`/teacher/students/${s.id}`} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
