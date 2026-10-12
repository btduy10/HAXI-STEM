"use client";

import { DashboardError } from "@/components/dashboard-error";

// Lỗi khi dựng trang Tổng quan: báo trong khung của ứng dụng (menu vẫn dùng được), không để cả ứng dụng thành trang lỗi.
export default function TeacherDashboardError(props: { error: Error & { digest?: string }; retry: () => void }) {
  return <DashboardError {...props} />;
}
