import type { Metadata } from "next";
import { ConfirmButton, FormDialogButton } from "@/components/action-buttons";
import { AutoSubmitSelect } from "@/components/auto-submit-select";
import type { Field } from "@/components/form-dialog";
import { LinkButton } from "@/components/link-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { WEEKDAY_NAMES, addMonths, endOfMonth, isoWeekday, parseIsoDate, startOfMonth } from "@/lib/dates";
import { orderSlotFrames } from "@/domain/time-slots";
import { formatDate, formatMoney, formatTime, todayIso } from "@/lib/format";
import { SLOT_NAME_LABELS, TIMESHEET_ROLES } from "@/lib/validation/entities";
import {
  adjustSessionTimesheetAction,
  createTimesheetEntryAction,
  deleteTimesheetEntryAction,
  updateTimesheetEntryAction,
} from "@/server/actions/admin";
import { seesAllClasses } from "@/server/guard";
import { listTeachers, listTimeSlots } from "@/server/services/catalog";
import { listClasses } from "@/server/services/classes";
import { TIMESHEET_ROLE_LABEL, type TimesheetState, teacherTimesheet } from "@/server/services/timesheet";
import { requireMenu } from "@/server/session";

export const metadata: Metadata = { title: "Chấm công" };

const STATE_LABEL: Record<TimesheetState, string> = { taught: "Đã dạy", pending: "Chưa điểm danh", upcoming: "Chưa tới ngày" };
const hours = (minutes: number) => (minutes / 60).toLocaleString("vi-VN", { maximumFractionDigits: 1 });

export default async function TimesheetPage({ searchParams }: PageProps<"/admin/timesheet">) {
  const { actor, role, can } = await requireMenu("timesheet");
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) || undefined;
  };
  const [teachers, classes, slots] = await Promise.all([listTeachers(actor), listClasses(actor), listTimeSlots(actor)]);
  // Chỉ nhận id có trong danh sách (tránh truy vấn với giá trị tùy ý).
  const teacher = teachers.find((t) => t.id === one("teacherId")) ?? null;
  const cls = classes.find((c) => c.id === one("classId")) ?? null;

  // Mặc định: tháng hiện tại. Chọn lớp mà chưa nhập ngày thì lấy trọn thời gian của lớp (tính công theo khóa).
  const today = todayIso();
  const from = parseIsoDate(one("from"), cls ? cls.startDate : startOfMonth(today));
  const requestedTo = parseIsoDate(one("to"), cls ? cls.endDate : endOfMonth(today));
  const to = requestedTo < from ? from : requestedTo;

  const { rows, summary } = await teacherTimesheet(actor, { from, to, teacherId: teacher?.id, classId: cls?.id });
  const total = summary.reduce(
    (sum, s) => ({
      taught: sum.taught + s.taught,
      substitute: sum.substitute + s.substitute,
      assistant: sum.assistant + s.assistant,
      minutes: sum.minutes + s.minutes,
      pending: sum.pending + s.pending,
      amount: sum.amount + s.amount,
    }),
    { taught: 0, substitute: 0, assistant: 0, minutes: 0, pending: 0, amount: 0 },
  );
  // Mức lương là thông tin của mọi người: chỉ người thấy công của tất cả mới vào trang đặt mức lương.
  const canSeeRates = seesAllClasses(actor);

  // Form chấm công bổ sung và sửa chấm công. Phạm vi "lớp của mình" chỉ thao tác trên công của chính mình.
  const slotOptions = orderSlotFrames(slots).map((s) => ({
    value: s.id,
    label: `${(SLOT_NAME_LABELS as Record<string, string>)[s.name] ?? s.name} – Khung ${s.frame} (${formatTime(s.defaultStart)}–${formatTime(s.defaultEnd)})`,
  }));
  const classField: Field = {
    name: "classId",
    label: "Lớp",
    type: "select",
    required: true,
    options: classes.map((c) => ({ value: c.id, label: `${c.code} – ${c.name}` })),
  };
  const noteField: Field = { name: "note", label: "Ghi chú", type: "textarea" };
  const entryFields: Field[] = [
    {
      name: "teacherId",
      label: "Giáo viên",
      type: "select",
      required: true,
      options: teachers
        .filter((t) => seesAllClasses(actor) || t.id === actor.teacherId)
        .map((t) => ({ value: t.id, label: `${t.code} – ${t.fullName}` })),
    },
    { name: "date", label: "Ngày", type: "date", required: true },
    { name: "timeSlotId", label: "Ca – Khung giờ", type: "select", required: true, options: slotOptions },
    classField,
    {
      name: "role",
      label: "Vai trò",
      type: "select",
      required: true,
      defaultValue: "main",
      options: TIMESHEET_ROLES.map((r) => ({ value: r, label: TIMESHEET_ROLE_LABEL[r] })),
    },
    noteField,
  ];
  // Dòng công sinh từ buổi học: chỉ sửa Ngày, Ca – Khung giờ, Lớp. Buổi không gắn ca thì được để trống (giữ giờ của buổi).
  const adjustFields = (hasSlot: boolean): Field[] => [
    { name: "date", label: "Ngày", type: "date", required: true },
    { name: "timeSlotId", label: "Ca – Khung giờ", type: "select", required: hasSlot, options: slotOptions },
    classField,
    noteField,
  ];
  const showActions = can("edit") || role === "admin";

  const href = (range: { from: string; to: string }) => {
    const query = new URLSearchParams(range);
    if (teacher) query.set("teacherId", teacher.id);
    if (cls) query.set("classId", cls.id);
    return `/admin/timesheet?${query}`;
  };
  const lastMonth = addMonths(today, -1);
  // Xuất Excel theo đúng khoảng ngày và lớp đang xem; có teacherId thì là tệp riêng của giáo viên đó.
  const exportHref = (teacherId?: string) => {
    const query = new URLSearchParams({ format: "xlsx", from, to });
    if (teacherId) query.set("teacherId", teacherId);
    if (cls) query.set("classId", cls.id);
    return `/api/export/timesheet?${query}`;
  };
  const exportClass = "inline-flex h-9 items-center rounded-full border bg-white/80 px-4 text-sm font-medium hover:bg-muted";

  return (
    <div className="grid gap-4">
      <div>
        <h1 className="text-xl font-semibold sm:text-2xl">Chấm công giáo viên</h1>
        <p className="text-sm text-muted-foreground">
          Mỗi buổi đã điểm danh là một công cho người thực dạy (giáo viên dạy thay nếu có) và một công trợ giảng cho trợ giảng
          của buổi. Buổi đã hủy không tính. Chấm công bổ sung là dòng công ghi tay, không tạo buổi học. Sửa dòng công chỉ đổi
          trên bảng công, Thời khóa biểu và điểm danh giữ nguyên. Thành tiền = số công đã dạy × mức lương của giáo viên ở lớp đó.
        </p>
      </div>
      {(canSeeRates || can("add")) && (
        <div className="flex flex-wrap gap-2">
          {canSeeRates && (
            <LinkButton variant="outline" className="h-10" href="/admin/timesheet/rates">
              Mức lương giáo viên/Nhân viên
            </LinkButton>
          )}
          {can("add") && (
            <FormDialogButton
              label="Chấm công bổ sung"
              title="Chấm công bổ sung"
              description="Ghi thêm một công cho giáo viên. Không tạo buổi học trên Thời khóa biểu."
              fields={entryFields}
              initial={{ date: today, teacherId: teacher?.id ?? "", classId: cls?.id ?? "" }}
              action={createTimesheetEntryAction}
              successMessage="Đã chấm công bổ sung."
            />
          )}
        </div>
      )}

      <form className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto] lg:items-end">
        <label className="grid gap-1.5 text-sm font-medium">
          Từ ngày
          <Input type="date" name="from" defaultValue={from} className="h-11" />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Đến ngày
          <Input type="date" name="to" defaultValue={to} className="h-11" />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Giáo viên
          <AutoSubmitSelect name="teacherId" defaultValue={teacher?.id ?? ""}>
            <option value="">Tất cả giáo viên</option>
            {teachers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} – {t.fullName}
              </option>
            ))}
          </AutoSubmitSelect>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Lớp (tính theo khóa)
          <AutoSubmitSelect name="classId" defaultValue={cls?.id ?? ""} clearOnChange={["from", "to"]}>
            <option value="">Tất cả lớp</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} – {c.name}
              </option>
            ))}
          </AutoSubmitSelect>
        </label>
        <Button type="submit" variant="outline" className="h-11">
          Xem
        </Button>
      </form>
      <div className="flex flex-wrap gap-2">
        <LinkButton variant="outline" className="h-9" href={href({ from: startOfMonth(today), to: endOfMonth(today) })}>
          Tháng này
        </LinkButton>
        <LinkButton variant="outline" className="h-9" href={href({ from: lastMonth, to: endOfMonth(lastMonth) })}>
          Tháng trước
        </LinkButton>
        {cls && (
          <LinkButton variant="outline" className="h-9" href={href({ from: cls.startDate, to: cls.endDate })}>
            Cả khóa của lớp {cls.code}
          </LinkButton>
        )}
      </div>

      <section className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">
            Tổng công từ {formatDate(from)} đến {formatDate(to)}
          </h2>
          {summary.length > 0 && !teacher && (
            // Tải tệp: dùng thẻ <a> thường để trình duyệt tự tải về, không qua router.
            <a href={exportHref()} download className={exportClass}>
              Xuất Excel tổng hợp
            </a>
          )}
        </div>
        {summary.length === 0 ? (
          <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
            Không có buổi dạy nào trong khoảng thời gian này.
          </p>
        ) : (
          <div className="glass-solid min-w-0 overflow-x-auto rounded-2xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14 text-center">STT</TableHead>
                  <TableHead>Mã GV</TableHead>
                  <TableHead>Giáo viên</TableHead>
                  <TableHead className="text-center">Số buổi</TableHead>
                  <TableHead className="text-center">Dạy thay</TableHead>
                  <TableHead className="text-center">Trợ giảng</TableHead>
                  <TableHead className="text-center">Số giờ</TableHead>
                  <TableHead className="text-center">Chưa điểm danh</TableHead>
                  <TableHead className="text-right">Mức lương</TableHead>
                  <TableHead className="text-right">Thành tiền</TableHead>
                  <TableHead>Xuất file riêng</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.map((s, index) => (
                  <TableRow key={s.teacherId}>
                    <TableCell className="text-center text-muted-foreground tabular-nums">{index + 1}</TableCell>
                    <TableCell>{s.teacherCode}</TableCell>
                    <TableCell className="whitespace-normal">{s.teacherName}</TableCell>
                    <TableCell className="text-center font-semibold tabular-nums">{s.taught}</TableCell>
                    <TableCell className="text-center tabular-nums">{s.substitute}</TableCell>
                    <TableCell className="text-center tabular-nums">{s.assistant}</TableCell>
                    <TableCell className="text-center tabular-nums">{hours(s.minutes)}</TableCell>
                    <TableCell className="text-center tabular-nums">{s.pending}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {s.rates.length === 0 ? "—" : s.rates.map((r) => formatMoney(r)).join(" / ")}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {formatMoney(s.amount)}
                      {s.missingRate > 0 && (
                        <span className="block text-xs font-normal text-destructive">{s.missingRate} công chưa có mức lương</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <a href={exportHref(s.teacherId)} download className={exportClass} aria-label={`Xuất Excel của ${s.teacherName}`}>
                        Excel
                      </a>
                    </TableCell>
                  </TableRow>
                ))}
                {summary.length > 1 && (
                  <TableRow className="font-semibold">
                    <TableCell />
                    <TableCell />
                    <TableCell>Tổng cộng</TableCell>
                    <TableCell className="text-center tabular-nums">{total.taught}</TableCell>
                    <TableCell className="text-center tabular-nums">{total.substitute}</TableCell>
                    <TableCell className="text-center tabular-nums">{total.assistant}</TableCell>
                    <TableCell className="text-center tabular-nums">{hours(total.minutes)}</TableCell>
                    <TableCell className="text-center tabular-nums">{total.pending}</TableCell>
                    <TableCell />
                    <TableCell className="text-right tabular-nums">{formatMoney(total.amount)}</TableCell>
                    <TableCell />
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {rows.length > 0 && (
        <section className="grid gap-2">
          <h2 className="font-semibold">
            Chi tiết buổi dạy <span className="text-sm font-normal text-muted-foreground">({rows.length})</span>
          </h2>
          <div className="glass-solid min-w-0 overflow-x-auto rounded-2xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14 text-center">STT</TableHead>
                  <TableHead>Thứ</TableHead>
                  <TableHead>Ngày</TableHead>
                  <TableHead>Giờ</TableHead>
                  <TableHead>Giáo viên</TableHead>
                  <TableHead>Vai trò</TableHead>
                  <TableHead>Lớp</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead className="text-right">Mức lương</TableHead>
                  <TableHead className="text-right">Thành tiền</TableHead>
                  <TableHead>Ghi chú</TableHead>
                  {showActions && <TableHead>Thao tác</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, index) => (
                  <TableRow key={r.key}>
                    <TableCell className="text-center text-muted-foreground tabular-nums">{index + 1}</TableCell>
                    <TableCell>{WEEKDAY_NAMES[isoWeekday(r.date)]}</TableCell>
                    <TableCell>{formatDate(r.date)}</TableCell>
                    <TableCell className="tabular-nums">
                      {formatTime(r.startTime)}–{formatTime(r.endTime)}
                    </TableCell>
                    <TableCell>{r.teacherName}</TableCell>
                    <TableCell>{TIMESHEET_ROLE_LABEL[r.role]}</TableCell>
                    <TableCell>
                      {r.className}
                      {r.kind === "makeup" && (
                        <Badge variant="outline" className="ml-1">
                          Buổi bù
                        </Badge>
                      )}
                      {r.source === "manual" && (
                        <Badge variant="outline" className="ml-1">
                          Bổ sung
                        </Badge>
                      )}
                      {r.edited && (
                        <Badge variant="outline" className="ml-1">
                          Đã sửa
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.state === "taught" ? "default" : r.state === "pending" ? "destructive" : "secondary"}>
                        {STATE_LABEL[r.state]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.rate === null ? "—" : formatMoney(r.rate)}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.amount === null ? "—" : formatMoney(r.amount)}</TableCell>
                    <TableCell className="max-w-56 whitespace-normal">{r.note ?? ""}</TableCell>
                    {showActions && (
                      <TableCell>
                        <div className="flex gap-2">
                          {can("edit") &&
                            (r.source === "manual" ? (
                              <FormDialogButton
                                label="Sửa"
                                title="Sửa công bổ sung"
                                variant="outline"
                                className="h-9"
                                fields={entryFields}
                                initial={{
                                  teacherId: r.teacherId,
                                  date: r.date,
                                  timeSlotId: r.timeSlotId ?? "",
                                  classId: r.classId,
                                  role: r.role,
                                  note: r.note ?? "",
                                }}
                                fixed={{ id: r.id }}
                                action={updateTimesheetEntryAction}
                              />
                            ) : (
                              <FormDialogButton
                                label="Sửa"
                                title={`Sửa chấm công – ${r.teacherName}`}
                                description="Chỉ đổi trên bảng công. Buổi học trên Thời khóa biểu và điểm danh giữ nguyên."
                                variant="outline"
                                className="h-9"
                                fields={adjustFields(r.timeSlotId !== null)}
                                initial={{ date: r.date, timeSlotId: r.timeSlotId ?? "", classId: r.classId, note: r.note ?? "" }}
                                fixed={{ sessionId: r.id, part: r.part ?? "lead" }}
                                action={adjustSessionTimesheetAction}
                              />
                            ))}
                          {role === "admin" && r.source === "manual" && (
                            <ConfirmButton
                              label="Xóa"
                              confirmText={`Xóa công bổ sung ngày ${formatDate(r.date)} của ${r.teacherName}?`}
                              action={deleteTimesheetEntryAction}
                              input={{ id: r.id }}
                              variant="outline"
                              className="h-9"
                              successMessage="Đã xóa công bổ sung."
                            />
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
    </div>
  );
}
