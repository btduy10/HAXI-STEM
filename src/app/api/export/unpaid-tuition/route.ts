import { handleExport } from "@/server/export-route";
import { unpaidTuitionDoc } from "@/server/services/finance";
import { paramId } from "@/lib/search-params";

/** Xuất danh sách học viên chưa đóng đủ học phí (cả trung tâm hoặc một lớp). Service kiểm tra quyền Báo cáo. */
export async function GET(request: Request) {
  return handleExport(request, "unpaid_tuition", null, async (actor) => {
    return unpaidTuitionDoc(actor, { classId: paramId(new URL(request.url).searchParams.get("classId")) });
  });
}
