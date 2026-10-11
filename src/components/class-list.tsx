import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { LABELS, formatDate } from "@/lib/format";

type ClassItem = {
  id: string;
  code: string;
  name: string;
  roomName: string | null;
  startDate: string;
  endDate: string;
  maxSize: number;
  status: "open" | "closed";
  studentCount: number;
};

export function ClassList({ classes, basePath }: { classes: ClassItem[]; basePath: string }) {
  if (classes.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
        Bạn chưa được phân công lớp nào.
      </p>
    );
  }
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {classes.map((c) => (
        <li key={c.id}>
          <Link href={`${basePath}/${c.id}`} className="block glass-solid rounded-2xl border p-3 text-sm hover:bg-muted">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">
                {c.code} – {c.name}
              </span>
              <Badge variant={c.status === "open" ? "secondary" : "outline"}>{LABELS.classStatus[c.status]}</Badge>
            </div>
            <p className="mt-1 text-muted-foreground">
              {c.roomName && `${c.roomName} · `}
              {c.studentCount}/{c.maxSize} học viên
            </p>
            <p className="text-muted-foreground">
              {formatDate(c.startDate)} – {formatDate(c.endDate)}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}
