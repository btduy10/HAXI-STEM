import type { Metadata } from "next";
import { QuickStats, kpiCards } from "@/components/center-3d/overview";
import { Stage } from "@/components/center-3d/stage";
import { DashboardCharts } from "@/components/dashboard-charts";
import { formatDate, formatTime } from "@/lib/format";
import { can, seesAllClasses } from "@/server/guard";
import { listOverdueSessions } from "@/server/services/attendance";
import { listClasses } from "@/server/services/classes";
import { centerKpis, centerToday, dashboardCharts } from "@/server/services/dashboard";
import { requirePageUser, roleLabelOf } from "@/server/session";

export const metadata: Metadata = { title: "Tổng quan" };

/** Số buổi quá hạn gửi xuống trình duyệt để liệt kê. */
const OVERDUE_SHOWN = 8;

// Tổng quan kiểu dashboard 3D isometric của khu vực giảng dạy. Mọi số liệu theo phạm vi lớp của người dùng (do service áp).
export default async function TeacherDashboardPage() {
  const user = await requirePageUser("teacher");
  // Vai trò được xem mọi lớp (vd. Giáo viên trực) thấy số liệu toàn trung tâm.
  const all = seesAllClasses(user.actor);
  const attendanceHref = (id: string) => `/teacher/sessions/${id}/attendance`;
  const [center, kpis, overdue, classes, charts, role] = await Promise.all([
    // Buổi của lớp chỉ hiển thị trên Thời khóa biểu không có điểm danh nên không bấm vào được.
    centerToday(user.actor, (s) => (s.timetableOnly ? null : attendanceHref(s.id))),
    centerKpis(user.actor),
    listOverdueSessions(user.actor),
    listClasses(user.actor),
    dashboardCharts(user.actor),
    roleLabelOf(user),
  ]);
  const open = classes.filter((c) => c.status === "open");
  return (
    <Stage
      data={{
        center,
        kpis: [
          ...kpiCards(kpis, { students: "/teacher/timetable", attendance: null, stars: null }),
          // Buổi quá hạn không có trang danh sách riêng ở khu vực giảng dạy: xem danh sách dưới chuông ở thanh trên.
          { label: "Buổi quá hạn chưa điểm danh", value: overdue.length, href: null, alert: true },
        ],
        overdue: overdue.slice(0, OVERDUE_SHOWN).map((s) => ({
          id: s.id,
          title: s.className,
          detail: `${formatDate(s.date)} · ${formatTime(s.startTime)}–${formatTime(s.endTime)}`,
          href: attendanceHref(s.id),
          locked: s.locked,
        })),
        overdueTotal: overdue.length,
        overdueHref: null,
        user: { name: user.name, role },
        // Chỉ để ẩn nút; từng hàm ở máy chủ vẫn kiểm tra quyền và phạm vi lớp.
        perms: { attendance: can(user.actor, "attendance", "view"), stars: can(user.actor, "stars", "view"), students: can(user.actor, "students", "view") },
        studentBase: "/teacher/students",
      }}
    >
      <QuickStats
        items={[
          { label: "buổi học hôm nay", value: center.sessions.filter((s) => !s.cancelled).length, href: "/teacher/timetable" },
          { label: all ? "lớp đang mở" : "lớp đang dạy", value: open.length, href: "/teacher/classes" },
        ]}
      />
      <DashboardCharts data={charts} scopeLabel={all ? "toàn trung tâm" : "các lớp của tôi"} />
    </Stage>
  );
}
