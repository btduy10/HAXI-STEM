"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { generateNextWeekAction, generateNextWeekForAllAction } from "@/server/actions/schedule";

/**
 * Sinh buổi học cho tuần sau từ lịch mẫu rồi mở Thời khóa biểu ở tuần đó.
 * Có `classId` (trang chi tiết lớp): xếp lại tuần sau của lớp đó. Không có (Thời khóa biểu): bổ sung buổi còn thiếu cho mọi lớp.
 */
export function GenerateSessionsButton({ classId, disabled }: { classId?: string; disabled?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function run() {
    if (
      classId &&
      !window.confirm(
        "Sinh buổi học tuần sau cho lớp theo lịch mẫu hiện tại? Các buổi chưa dạy của tuần sau (kể cả buổi xếp tay, buổi đã sửa riêng) được xếp lại đúng thứ, ca, phòng, giáo viên của lịch mẫu. Buổi đã điểm danh, đã ghi sao, đã hủy, buổi bù và các tuần khác giữ nguyên.",
      )
    )
      return;
    startTransition(async () => {
      const response = classId ? await generateNextWeekAction({ classId }) : await generateNextWeekForAllAction();
      if (!response.ok) return void toast.error(response.error);
      const { week, created, warnings } = response.data;
      const range = `${formatDate(week.from)} – ${formatDate(week.to)}`;
      toast.success(created > 0 ? `Đã tạo ${created} buổi cho tuần ${range}.` : `Tuần ${range} không có buổi nào cần tạo thêm.`);
      for (const warning of warnings) toast.warning(warning, { duration: 10_000 });
      router.push(`/admin/timetable?${new URLSearchParams({ view: "week", date: week.from, ...(classId ? { classId } : {}) })}`);
    });
  }

  return (
    <Button className="h-10 w-fit" disabled={pending || disabled} onClick={run}>
      {pending ? "Đang sinh buổi…" : classId ? "Sinh buổi học tuần sau" : "Sinh lịch tuần sau"}
    </Button>
  );
}
