import type { Metadata } from "next";
import { Stage } from "@/components/center-3d/stage";
import { DashboardCharts } from "@/components/dashboard-charts";
import { formatDate, formatTime } from "@/lib/format";
import { listOverdueSessions } from "@/server/services/attendance";
import { adminOverview, centerToday, dashboardCharts } from "@/server/services/dashboard";
import { requirePageUser, roleLabelOf } from "@/server/session";

export const metadata: Metadata = { title: "Tổng quan" };

/** Số buổi quá hạn gửi xuống trình duyệt để liệt kê; phần còn lại xem ở trang Điểm danh. */
const OVERDUE_SHOWN = 8;

// Tổng quan kiểu dashboard 3D isometric. Chỉ đọc dữ liệu qua các service sẵn có (đã kiểm tra quyền); không có thao tác ghi.
export default async function AdminDashboardPage() {
  const user = await requirePageUser("admin");
  const [overview, overdue, charts, center, role] = await Promise.all([
    adminOverview(user.actor),
    listOverdueSessions(user.actor),
    dashboardCharts(user.actor),
    centerToday(user.actor, (s) => `/admin/sessions/${s.id}`),
    roleLabelOf(user),
  ]);
  return (
    <Stage
      data={{
        center,
        kpis: [
          { label: "Học viên đang học", value: overview.activeStudents, href: "/admin/students" },
          { label: "Giáo viên đang dạy", value: overview.activeTeachers, href: "/admin/teachers" },
          { label: "Lớp đang mở", value: overview.openClasses, href: "/admin/classes" },
          { label: "Buổi quá hạn chưa điểm danh", value: overdue.length, href: "/admin/attendance", alert: true },
        ],
        overdue: overdue.slice(0, OVERDUE_SHOWN).map((s) => ({
          id: s.id,
          title: s.className,
          detail: `${formatDate(s.date)} · ${formatTime(s.startTime)}–${formatTime(s.endTime)}`,
          href: `/admin/attendance/${s.id}`,
          locked: s.locked,
        })),
        overdueTotal: overdue.length,
        overdueHref: "/admin/attendance",
        classes: charts.classRates.map((c) => ({
          id: c.classId,
          title: c.name,
          detail: `Chuyên cần ${c.rate}% · ${c.total} lượt điểm danh`,
          href: `/admin/classes/${c.classId}`,
        })),
        classesLabel: "Lớp",
        classesEmpty: "Chưa có lớp đang mở nào được điểm danh.",
        user: { name: user.name, role },
      }}
    >
      <DashboardCharts data={charts} scopeLabel="toàn trung tâm" />
    </Stage>
  );
}
