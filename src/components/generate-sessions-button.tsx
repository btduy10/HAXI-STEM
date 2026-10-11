"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { generateNextWeekForAllAction } from "@/server/actions/schedule";

/**
 * Nút ở Thời khóa biểu: bổ sung buổi còn thiếu của tuần sau cho mọi lớp đang mở theo lịch mẫu, rồi mở Thời khóa biểu ở tuần đó.
 * Bình thường tác vụ hằng ngày đã làm việc này; nút để sinh ngay khi cần.
 */
export function GenerateSessionsButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      const response = await generateNextWeekForAllAction();
      if (!response.ok) return void toast.error(response.error);
      const { week, created, warnings } = response.data;
      const range = `${formatDate(week.from)} – ${formatDate(week.to)}`;
      toast.success(created > 0 ? `Đã tạo ${created} buổi cho tuần ${range}.` : `Tuần ${range} không có buổi nào cần tạo thêm.`);
      for (const warning of warnings) toast.warning(warning, { duration: 10_000 });
      router.push(`/admin/timetable?${new URLSearchParams({ view: "week", date: week.from })}`);
    });
  }

  return (
    <Button className="h-10 w-fit" disabled={pending} onClick={run}>
      {pending ? "Đang sinh buổi…" : "Sinh lịch tuần sau"}
    </Button>
  );
}
