import type { Metadata } from "next";
import { todayIso } from "@/lib/format";
import { paramText } from "@/lib/search-params";
import { orNotFound, uuidParam } from "@/server/page";
import { listRooms, listTeachers, listTimeSlots } from "@/server/services/catalog";
import { getClass, listClassTeachers } from "@/server/services/classes";
import { listClassStudents } from "@/server/services/students";
import { redirect } from "next/navigation";
import { requireMenu } from "@/server/session";
import { MakeupForm } from "./makeup-form";
import { BackLink } from "@/components/back-link";

export const metadata: Metadata = { title: "Thêm buổi bù" };

export default async function MakeupPage({ searchParams }: PageProps<"/admin/sessions/makeup">) {
  const { actor, can } = await requireMenu("timetable");
  if (!can("add")) redirect("/admin/timetable");
  const classId = uuidParam(paramText((await searchParams).classId));
  const cls = await orNotFound(getClass(actor, classId));
  const [students, teachers, rooms, slots, assigned] = await Promise.all([
    listClassStudents(actor, classId),
    listTeachers(actor),
    listRooms(actor),
    listTimeSlots(actor),
    listClassTeachers(actor, classId),
  ]);

  return (
    <div className="grid max-w-2xl gap-4">
      <div className="grid gap-1">
        <BackLink href={`/admin/classes/${classId}`}>{cls.code} – {cls.name}</BackLink>
        <h1 className="text-xl font-semibold sm:text-2xl">Thêm buổi bù</h1>
        <p className="text-sm text-muted-foreground">Buổi bù chỉ gồm các học viên được chọn bên dưới.</p>
      </div>
      <MakeupForm
        classId={classId}
        defaults={{
          date: todayIso(),
          startTime: slots[0]?.defaultStart.slice(0, 5) ?? "08:00",
          endTime: slots[0]?.defaultEnd.slice(0, 5) ?? "09:30",
          roomId: cls.defaultRoomId ?? "",
          teacherId: assigned.find((a) => a.role === "main")?.teacherId ?? assigned[0]?.teacherId ?? "",
        }}
        students={students.map((s) => ({ id: s.id, label: `${s.fullName} (${s.code})` }))}
        teachers={teachers.filter((t) => t.status === "active").map((t) => ({ value: t.id, label: `${t.code} – ${t.fullName}` }))}
        rooms={rooms.map((r) => ({ value: r.id, label: `${r.name} (${r.capacity} chỗ)` }))}
      />
    </div>
  );
}
