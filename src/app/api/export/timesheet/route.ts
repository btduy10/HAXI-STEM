import { daysBetween, endOfMonth, startOfMonth } from "@/lib/dates";
import { todayIso } from "@/lib/format";
import { paramDate, paramId } from "@/lib/search-params";
import { AppError } from "@/server/errors";
import { handleExport } from "@/server/export-route";
import { timesheetDoc } from "@/server/services/timesheet";

/** Xuất chấm công: tệp tổng hợp mọi giáo viên, hoặc tệp riêng một giáo viên khi có teacherId. Service kiểm tra quyền và phạm vi. */
export async function GET(request: Request) {
  return handleExport(request, "timesheet", null, async (actor) => {
    const params = new URL(request.url).searchParams;
    const today = todayIso();
    const from = paramDate(params.get("from"), startOfMonth(today));
    const to = paramDate(params.get("to"), endOfMonth(today));
    if (to < from || daysBetween(from, to) > 366) throw new AppError("VALIDATION", "Khoảng ngày xuất tối đa 1 năm.");
    return timesheetDoc(actor, { from, to, teacherId: paramId(params.get("teacherId")), classId: paramId(params.get("classId")) });
  });
}
