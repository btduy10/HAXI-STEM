import { addDays, daysBetween } from "@/lib/dates";
import { todayIso } from "@/lib/format";
import { paramDate, paramId } from "@/lib/search-params";
import { AppError } from "@/server/errors";
import { handleExport } from "@/server/export-route";
import { can } from "@/server/guard";
import { timetableDoc } from "@/server/services/reports";

/** Xuất TKB. Ai được xem menu Thời khóa biểu thì lọc theo GV/lớp/phòng; còn lại chỉ nhận lịch cá nhân (service giới hạn phạm vi). */
export async function GET(request: Request) {
  return handleExport(request, "timetable", null, async (actor) => {
    const params = new URL(request.url).searchParams;
    const today = todayIso();
    const from = paramDate(params.get("from"), today);
    const to = paramDate(params.get("to"), addDays(from, 6));
    if (to < from || daysBetween(from, to) > 92) throw new AppError("VALIDATION", "Khoảng ngày xuất tối đa 3 tháng.");
    const personal = !can(actor, "timetable", "view");
    return timetableDoc(actor, {
      from,
      to,
      classId: paramId(params.get("classId")),
      teacherId: paramId(params.get("teacherId")),
      roomId: paramId(params.get("roomId")),
      personal,
    });
  });
}