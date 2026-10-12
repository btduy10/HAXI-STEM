import type { Metadata } from "next";
import { CenterView } from "@/components/center-3d/center-view";
import { ClassList } from "@/components/class-list";
import { DashboardCharts } from "@/components/dashboard-charts";
import { DashboardHero } from "@/components/dashboard-hero";
import { LinkButton } from "@/components/link-button";
import { OverdueSessions, TodaySessions } from "@/components/session-lists";
import { todayIso } from "@/lib/format";
import { seesAllClasses } from "@/server/guard";
import { listOverdueSessions } from "@/server/services/attendance";
import { listClasses } from "@/server/services/classes";
import { centerToday, dashboardCharts } from "@/server/services/dashboard";
import { listSessions } from "@/server/services/sessions";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Tổng quan" };

const HREF = "/teacher/dashboard";
// Giao diện 3D đang TẠM TẮT: trên bản chạy thật, mở ?view=3d báo lỗi máy chủ (chưa rõ nguyên nhân). Tắt cả nút "Xem 3D" lẫn
// nhánh ?view=3d (địa chỉ cũ hiện giao diện thường) cho tới khi sửa xong.
const CENTER_3D: boolean = false;

export default async function TeacherDashboardPage({ searchParams }: PageProps<"/teacher/dashboard">) {
  const user = await requirePageUser("teacher");
  const today = todayIso();
  // Vai trò được xem mọi lớp (vd. Giáo viên trực) thấy số liệu toàn trung tâm.
  const all = seesAllClasses(user.actor);
  const attendanceHref = (id: string) => `/teacher/sessions/${id}/attendance`;
  // ?view=3d: giao diện 3D của trung tâm; buổi học theo phạm vi lớp của người dùng, bấm để mở trang điểm danh.
  if (CENTER_3D && (await searchParams).view === "3d") {
    // Buổi của lớp chỉ hiển thị trên Thời khóa biểu không có điểm danh nên không bấm vào được.
    const center = await centerToday(user.actor, (s) => (s.timetableOnly ? null : attendanceHref(s.id)));
    return (
      <div className="grid gap-6">
        <DashboardHero
          name={user.name}
          description={all ? "Trung tâm hôm nay dưới dạng mô hình 3D." : "Các lớp của bạn hôm nay dưới dạng mô hình 3D."}
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
  const [todaySessions, overdue, classes, charts] = await Promise.all([
    listSessions(user.actor, { from: today, to: today, personal: true }),
    listOverdueSessions(user.actor),
    listClasses(user.actor),
    dashboardCharts(user.actor),
  ]);

  return (
    <div className="grid gap-6">
      <DashboardHero
        name={user.name}
        description={all ? "Tổng quan hoạt động của trung tâm hôm nay." : "Tổng quan các lớp của bạn hôm nay."}
        action={
          CENTER_3D ? (
            <LinkButton href={`${HREF}?view=3d`} variant="outline" className="h-10">
              Xem 3D
            </LinkButton>
          ) : undefined
        }
      />
      <TodaySessions sessions={todaySessions} hrefOf={(s) => attendanceHref(s.id)} today={today} />
      <OverdueSessions sessions={overdue} hrefOf={attendanceHref} />
      <DashboardCharts data={charts} scopeLabel={all ? "toàn trung tâm" : "các lớp của tôi"} />
      <section className="grid gap-2">
        <h2 className="font-medium">{all ? "Lớp đang mở" : "Lớp đang dạy"}</h2>
        <ClassList classes={classes.filter((c) => c.status === "open")} basePath="/teacher/classes" />
      </section>
    </div>
  );
}
