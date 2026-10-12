import type { Metadata } from "next";
import Link from "next/link";
import { CenterView } from "@/components/center-3d/center-view";
import { CountUp } from "@/components/count-up";
import { DashboardCharts } from "@/components/dashboard-charts";
import { DashboardHero } from "@/components/dashboard-hero";
import { LinkButton } from "@/components/link-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listOverdueSessions } from "@/server/services/attendance";
import { adminOverview, centerToday, dashboardCharts } from "@/server/services/dashboard";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Tổng quan" };

const HREF = "/admin/dashboard";
// Giao diện 3D đang TẠM TẮT: trên bản chạy thật, mở ?view=3d báo lỗi máy chủ (chưa rõ nguyên nhân). Tắt cả nút "Xem 3D" lẫn
// nhánh ?view=3d (địa chỉ cũ hiện giao diện thường) cho tới khi sửa xong.
const CENTER_3D: boolean = false;

export default async function AdminDashboardPage({ searchParams }: PageProps<"/admin/dashboard">) {
  const user = await requirePageUser("admin");
  // ?view=3d: giao diện 3D của trung tâm thay cho phần số liệu; chỉ khi đó mới đọc dữ liệu phòng và buổi hôm nay.
  if (CENTER_3D && (await searchParams).view === "3d") {
    const center = await centerToday(user.actor, (s) => `/admin/sessions/${s.id}`);
    return (
      <div className="grid gap-6">
        <DashboardHero
          name={user.name}
          description="Trung tâm hôm nay dưới dạng mô hình 3D."
          action={
            <LinkButton href={HREF} variant="outline" className="h-10">
              Giao diện thường
            </LinkButton>
          }
        />
        <CenterView data={center} backHref={HREF} />
      </div>
    );
  }
  const [overview, overdue, charts] = await Promise.all([
    adminOverview(user.actor),
    listOverdueSessions(user.actor),
    dashboardCharts(user.actor),
  ]);
  const stats = [
    { label: "Học viên đang học", value: overview.activeStudents, href: "/admin/students" },
    { label: "Giáo viên đang dạy", value: overview.activeTeachers, href: "/admin/teachers" },
    { label: "Lớp đang mở", value: overview.openClasses, href: "/admin/classes" },
    { label: "Buổi quá hạn chưa điểm danh", value: overdue.length, href: "/admin/attendance" },
  ];
  return (
    <div className="grid gap-6">
      <DashboardHero
        name={user.name}
        description="Tổng quan hoạt động của trung tâm hôm nay."
        action={
          CENTER_3D ? (
            <LinkButton href={`${HREF}?view=3d`} variant="outline" className="h-10">
              Xem 3D
            </LinkButton>
          ) : undefined
        }
      />
      <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Link key={s.href} href={s.href} className="rounded-3xl focus-visible:outline-2">
            <Card className="card-lift h-full justify-between">
              <CardHeader>
                <CardTitle className="text-sm font-normal text-muted-foreground">{s.label}</CardTitle>
              </CardHeader>
              <CardContent className="text-4xl leading-none font-bold tabular-nums">
                <CountUp value={s.value} />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
      <DashboardCharts data={charts} scopeLabel="toàn trung tâm" />
    </div>
  );
}
