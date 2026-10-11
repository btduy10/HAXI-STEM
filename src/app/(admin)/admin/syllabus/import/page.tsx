import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ExcelImportForm } from "@/components/excel-import-form";
import { requireMenu } from "@/server/session";

export const metadata: Metadata = { title: "Nhập Syllabus từ Excel" };

export default async function ImportSyllabusPage() {
  // Nhập Excel đi theo quyền Thêm của menu Syllabus; máy chủ kiểm tra lại khi gửi tệp.
  const { can } = await requireMenu("syllabus");
  if (!can("add")) redirect("/admin/syllabus");
  return (
    <ExcelImportForm
      kind="syllabus"
      note="Năm cột: Khóa học (tên khóa ở menu Khóa học), Lớp học (tên lớp, hoặc mã lớp nếu có hai lớp trùng tên), Buổi, Tên bài/Chủ đề, Sản phẩm (để trống được). Chỉ nhập được vào lớp trong phạm vi của bạn. Bài đã có cùng Lớp học + Khóa học + Buổi sẽ được cập nhật tên bài và sản phẩm."
    />
  );
}
