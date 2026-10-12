import Link from "next/link";
import { kpiDelta } from "@/domain/center-3d";
import type { CenterKpis } from "@/server/services/dashboard";
import type { StageKpi } from "./panels";

// Phần dựng ở máy chủ của trang Tổng quan: đổi số liệu KPI thành thẻ, và hàng số liệu chung phía trên biểu đồ.

/** Ba thẻ KPI có so sánh kỳ trước: học viên hôm nay, tỉ lệ điểm danh tuần này, sao trong tuần. */
export function kpiCards(kpis: CenterKpis, hrefs: { students: string | null; attendance: string | null; stars: string | null }): StageKpi[] {
  const versus = (delta: ReturnType<typeof kpiDelta>, label: string) => (delta ? { ...delta, versus: label } : null);
  return [
    {
      label: "Học viên hôm nay",
      value: kpis.studentsToday.value,
      href: hrefs.students,
      delta: versus(kpiDelta(kpis.studentsToday.value, kpis.studentsToday.previous), "cùng thứ tuần trước"),
    },
    {
      label: "Tỉ lệ điểm danh tuần này",
      value: kpis.attendanceRate.value,
      suffix: "%",
      href: hrefs.attendance,
      delta: versus(kpiDelta(kpis.attendanceRate.value, kpis.attendanceRate.previous), "cùng kỳ tuần trước"),
    },
    {
      label: "Sao đã trao trong tuần",
      value: kpis.starsWeek.value,
      href: hrefs.stars,
      delta: versus(kpiDelta(kpis.starsWeek.value, kpis.starsWeek.previous), "cùng kỳ tuần trước"),
    },
  ];
}

/** Hàng số liệu chung (số học viên, giáo viên, lớp…) phía trên biểu đồ; mỗi số dẫn tới trang của nó. */
export function QuickStats({ items }: { items: { label: string; value: number; href: string }[] }) {
  return (
    <ul aria-label="Số liệu chung" className="flex flex-wrap gap-2">
      {items.map((item) => (
        <li key={item.label}>
          <Link
            href={item.href}
            className="panel flex min-h-11 items-center gap-2 px-3.5 py-2 text-sm outline-none hover:bg-primary-soft focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <span className="text-lg leading-none font-semibold tabular-nums">{item.value}</span>
            <span className="text-ink-soft">{item.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
