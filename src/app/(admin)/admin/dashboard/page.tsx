import type { Metadata } from "next";
import { QuickStats, kpiCards, stageNotice } from "@/components/center-3d/overview";
import { Stage } from "@/components/center-3d/stage";
import { DashboardCharts } from "@/components/dashboard-charts";
import { formatDate, formatTime } from "@/lib/format";
import { listOverdueSessions } from "@/server/services/attendance";
import { orFallback } from "@/server/page";
import { adminOverview, centerKpis, centerToday, dashboardCharts, emptyCenter } from "@/server/services/dashboard";
import { requirePageUser, roleLabelOf } from "@/server/session";

export const metadata: Metadata = { title: "Tổng quan" };

/** Số buổi quá hạn gửi xuống trình duyệt để liệt kê; phần còn lại xem ở trang Điểm danh. */
const OVERDUE_SHOWN = 8;

// Tổng quan kiểu dashboard 3D isometric. Dữ liệu của trang chỉ đọc qua các service đã kiểm tra quyền; chi tiết học viên chỉ tải
// khi người dùng mở một buổi; điểm danh và ghi sao trên trang dùng đúng các action của trang Điểm danh và trang Ghi sao.
export default async function AdminDashboardPage() {
  const user = await requirePageUser("admin");
  // Dữ liệu của cảnh và ba thẻ KPI mới là phần phụ: nếu lỗi thì trang vẫn mở với các số liệu còn lại và một dòng báo.
  const [overview, kpis, overdue, charts, center, role] = await Promise.all([
    adminOverview(user.actor),
    orFallback("centerKpis", centerKpis(user.actor), null),
    listOverdueSessions(user.actor),
    dashboardCharts(user.actor),
    orFallback("centerToday", centerToday(user.actor, (s) => `/admin/sessions/${s.id}`), null),
    roleLabelOf(user),
  ]);
  return (
    <Stage
      data={{
        center: center ?? emptyCenter(),
        notice: stageNotice(center === null, kpis === null),
        kpis: [
          ...(kpis ? kpiCards(kpis, { students: "/admin/timetable", attendance: "/admin/attendance", stars: "/admin/stars" }) : []),
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
        user: { name: user.name, role },
        perms: { attendance: true, stars: true, students: true },
        studentBase: "/admin/students",
      }}
    >
      <QuickStats
        items={[
          { label: "học viên đang học", value: overview.activeStudents, href: "/admin/students" },
          { label: "giáo viên đang dạy", value: overview.activeTeachers, href: "/admin/teachers" },
          { label: "lớp đang mở", value: overview.openClasses, href: "/admin/classes" },
        ]}
      />
      <DashboardCharts data={charts} scopeLabel="toàn trung tâm" />
    </Stage>
  );
}
