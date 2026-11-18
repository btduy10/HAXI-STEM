import type { Metadata } from "next";
import Link from "next/link";
import { AutoSubmitSelect } from "@/components/auto-submit-select";
import { ChartCard, ColumnChart } from "@/components/charts";
import { ExportLinks } from "@/components/class-report";
import { CrudSection } from "@/components/crud-section";
import type { Field } from "@/components/form-dialog";
import { LinkButton } from "@/components/link-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FINANCE_VIEWS, FINANCE_VIEW_LABEL, type FinanceView, compactMoney } from "@/domain/finance";
import { TUITION_STATUS_LABEL } from "@/domain/tuition";
import { endOfMonth } from "@/lib/dates";
import { LABELS, formatDate, formatMoney, todayIso } from "@/lib/format";
import { cn } from "@/lib/utils";
import { paramDate, paramText } from "@/lib/search-params";
import { createPurchaseAction, deletePurchaseAction, updatePurchaseAction } from "@/server/actions/admin";
import { type Actor, seesAllClasses } from "@/server/guard";
import { listClasses } from "@/server/services/classes";
import { financeReport, listPurchases, purchaseCategories, salaryByTeacher, unpaidTuition } from "@/server/services/finance";
import { requireMenu } from "@/server/session";

export const metadata: Metadata = { title: "Báo cáo" };

const TABS = [
  { key: "revenue", label: "Doanh thu" },
  { key: "salary", label: "Chi lương" },
  { key: "purchases", label: "Mua sắm" },
  { key: "unpaid", label: "Học phí chưa đóng" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

const METRICS = ["revenue", "expense", "profit"] as const;
type Metric = (typeof METRICS)[number];
const METRIC_LABEL: Record<Metric, string> = { revenue: "Doanh thu", expense: "Chi", profit: "Lãi" };

type Params = Record<string, string | string[] | undefined>;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthOf = (value: string, today: string) => (MONTH.test(value) ? value : today.slice(0, 7));
const monthLabel = (month: string) => `${Number(month.slice(5, 7))}/${month.slice(0, 4)}`;
const number = (n: number) => n.toLocaleString("vi-VN");
const empty = "rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground";

export default async function ReportsPage({ searchParams }: PageProps<"/admin/reports">) {
  const { actor, role, can } = await requireMenu("reports");
  const params = await searchParams;
  const tab: TabKey = TABS.find((t) => t.key === paramText(params.tab))?.key ?? "revenue";

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold sm:text-2xl">Báo cáo</h1>
      {!seesAllClasses(actor) ? (
        // Số liệu tài chính là của cả trung tâm: vai trò chỉ thấy lớp của mình không xem được.
        <p className={empty}>Báo cáo doanh thu, chi, lãi là số liệu của cả trung tâm nên chỉ dành cho vai trò có phạm vi “Tất cả lớp”.</p>
      ) : (
        <>
          <nav aria-label="Mục" className="flex gap-1 overflow-x-auto glass-solid rounded-full border p-1 text-sm">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={`/admin/reports?tab=${t.key}`}
                aria-current={tab === t.key ? "page" : undefined}
                className={cn(
                  "flex min-h-10 shrink-0 items-center rounded-full px-4 font-medium whitespace-nowrap transition-colors",
                  tab === t.key ? "bg-brand-teal font-semibold text-foreground shadow-sm" : "hover:bg-muted",
                )}
              >
                {t.label}
              </Link>
            ))}
          </nav>
          {tab === "revenue" && <RevenueTab actor={actor} params={params} />}
          {tab === "salary" && <SalaryTab actor={actor} params={params} canTimesheet={can("view", "timesheet")} />}
          {tab === "purchases" && <PurchasesTab actor={actor} params={params} perm={{ add: can("add"), edit: can("edit"), admin: role === "admin" }} />}
          {tab === "unpaid" && <UnpaidTab actor={actor} params={params} />}
        </>
      )}
    </div>
  );
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="grid min-w-0 gap-1 glass-card rounded-3xl p-5">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-xl font-bold break-words tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Doanh thu – Chi – Lãi theo tuần / tháng / năm, kèm biểu đồ của chỉ số đang chọn. */
async function RevenueTab({ actor, params }: { actor: Actor; params: Params }) {
  const today = todayIso();
  const view: FinanceView = FINANCE_VIEWS.find((v) => v === paramText(params.view)) ?? "month";
  const metric: Metric = METRICS.find((m) => m === paramText(params.metric)) ?? "revenue";
  const anchor = paramDate(params.date, today);
  const report = await financeReport(actor, { view, anchor });
  const range = `Từ ${formatDate(report.from)} đến ${formatDate(report.to)}`;
  const scope = view === "week" ? "12 tuần gần nhất" : view === "month" ? `12 tháng của năm ${anchor.slice(0, 4)}` : "5 năm gần nhất";

  return (
    <div className="grid gap-4">
      <form className="grid gap-2 sm:grid-cols-[repeat(3,minmax(0,1fr))_auto] sm:items-end">
        <input type="hidden" name="tab" value="revenue" />
        <label className="grid gap-1.5 text-sm font-medium">
          Xem theo
          <AutoSubmitSelect name="view" defaultValue={view}>
            {FINANCE_VIEWS.map((v) => (
              <option key={v} value={v}>
                {FINANCE_VIEW_LABEL[v]}
              </option>
            ))}
          </AutoSubmitSelect>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Chỉ số trên biểu đồ
          <AutoSubmitSelect name="metric" defaultValue={metric}>
            {METRICS.map((m) => (
              <option key={m} value={m}>
                {METRIC_LABEL[m]}
              </option>
            ))}
          </AutoSubmitSelect>
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Tính đến ngày
          <Input type="date" name="date" defaultValue={anchor} className="h-11" />
        </label>
        <Button type="submit" variant="outline" className="h-11">
          Xem
        </Button>
      </form>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile label="Tổng doanh thu" value={formatMoney(report.total.revenue)} hint="Phiếu thu học phí còn hiệu lực, theo ngày thu" />
        <StatTile
          label="Tổng chi"
          value={formatMoney(report.total.expense)}
          hint={`Lương ${formatMoney(report.total.salary)} · Mua sắm ${formatMoney(report.total.purchases)}`}
        />
        <StatTile label={report.total.profit < 0 ? "Lãi (đang lỗ)" : "Lãi"} value={formatMoney(report.total.profit)} hint="Doanh thu − Chi" />
      </div>
      {report.missingRate > 0 && (
        <p className="text-sm text-muted-foreground">
          Có {report.missingRate} công đã dạy chưa có mức lương nên chưa tính vào chi lương (đặt ở Chấm công → Mức lương giáo viên/Nhân viên).
        </p>
      )}

      <ChartCard title={`${METRIC_LABEL[metric]} theo ${FINANCE_VIEW_LABEL[view].toLowerCase()}`} subtitle={`${scope} · ${range}`}>
        <ColumnChart
          signed
          dense={report.rows.length > 8}
          unit="đ"
          format={number}
          tickFormat={compactMoney}
          emptyText="Chưa có số liệu trong khoảng thời gian này."
          data={report.rows.map((r) => ({ key: r.key, label: r.label, value: r[metric], detail: r.title }))}
        />
      </ChartCard>

      <section className="grid gap-2">
        <h2 className="font-semibold">Chi tiết theo {FINANCE_VIEW_LABEL[view].toLowerCase()}</h2>
        <div className="glass-solid min-w-0 overflow-x-auto rounded-2xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kỳ</TableHead>
                <TableHead className="text-right">Doanh thu</TableHead>
                <TableHead className="text-right">Chi lương</TableHead>
                <TableHead className="text-right">Mua sắm</TableHead>
                <TableHead className="text-right">Tổng chi</TableHead>
                <TableHead className="text-right">Lãi</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.rows.map((r) => (
                <TableRow key={r.key}>
                  <TableCell>{r.title}</TableCell>
                  <TableCell className="text-right tabular-nums">{number(r.revenue)}</TableCell>
                  <TableCell className="text-right tabular-nums">{number(r.salary)}</TableCell>
                  <TableCell className="text-right tabular-nums">{number(r.purchases)}</TableCell>
                  <TableCell className="text-right tabular-nums">{number(r.expense)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{number(r.profit)}</TableCell>
                </TableRow>
              ))}
              <TableRow className="font-semibold">
                <TableCell>Tổng cộng</TableCell>
                <TableCell className="text-right tabular-nums">{number(report.total.revenue)}</TableCell>
                <TableCell className="text-right tabular-nums">{number(report.total.salary)}</TableCell>
                <TableCell className="text-right tabular-nums">{number(report.total.purchases)}</TableCell>
                <TableCell className="text-right tabular-nums">{number(report.total.expense)}</TableCell>
                <TableCell className="text-right tabular-nums">{number(report.total.profit)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

function MonthForm({ tab, month }: { tab: TabKey; month: string }) {
  return (
    <form className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="tab" value={tab} />
      <label className="grid gap-1.5 text-sm font-medium">
        Tháng
        <Input type="month" name="month" defaultValue={month} className="h-11 w-44" />
      </label>
      <Button type="submit" variant="outline" className="h-11">
        Xem
      </Button>
    </form>
  );
}

/** Chi lương một tháng, từng giáo viên: lấy từ Chấm công (số công đã dạy × mức lương). */
async function SalaryTab({ actor, params, canTimesheet }: { actor: Actor; params: Params; canTimesheet: boolean }) {
  const month = monthOf(paramText(params.month), todayIso());
  const salary = await salaryByTeacher(actor, month);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <MonthForm tab="salary" month={month} />
        {canTimesheet && (
          <LinkButton variant="outline" className="h-10" href={`/admin/timesheet?from=${salary.from}&to=${salary.to}`}>
            Xem ở Chấm công
          </LinkButton>
        )}
      </div>
      <section className="grid gap-2">
        <h2 className="font-semibold">
          Lương giáo viên tháng {monthLabel(month)} <span className="text-sm font-normal text-muted-foreground">({salary.rows.length})</span>
        </h2>
        <p className="text-sm text-muted-foreground">
          Tự tính từ Chấm công: số công đã dạy × mức lương của giáo viên ở từng lớp. Công chưa có mức lương không cộng tiền.
        </p>
        {salary.rows.length === 0 ? (
          <p className={empty}>Tháng này chưa có công nào đã dạy.</p>
        ) : (
          <div className="glass-solid min-w-0 overflow-x-auto rounded-2xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14 text-center">STT</TableHead>
                  <TableHead>Mã GV</TableHead>
                  <TableHead>Giáo viên</TableHead>
                  <TableHead className="text-center">Số công</TableHead>
                  <TableHead className="text-center">Công trợ giảng</TableHead>
                  <TableHead className="text-right">Thành tiền</TableHead>
                  <TableHead>Ghi chú</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {salary.rows.map((s, index) => (
                  <TableRow key={s.teacherId}>
                    <TableCell className="text-center text-muted-foreground tabular-nums">{index + 1}</TableCell>
                    <TableCell>{s.teacherCode}</TableCell>
                    <TableCell className="whitespace-normal">{s.teacherName}</TableCell>
                    <TableCell className="text-center tabular-nums">{s.taught}</TableCell>
                    <TableCell className="text-center tabular-nums">{s.assistant}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{formatMoney(s.amount)}</TableCell>
                    <TableCell className="whitespace-normal">{s.missingRate > 0 ? `${s.missingRate} công chưa có mức lương` : ""}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="font-semibold">
                  <TableCell />
                  <TableCell />
                  <TableCell>Tổng cộng</TableCell>
                  <TableCell className="text-center tabular-nums">{salary.total.taught}</TableCell>
                  <TableCell className="text-center tabular-nums">{salary.total.assistant}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(salary.total.amount)}</TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

/** Mua sắm của một tháng: nhập hạng mục, loại, số lượng, đơn giá; thành tiền tự tính. */
async function PurchasesTab({ actor, params, perm }: { actor: Actor; params: Params; perm: { add: boolean; edit: boolean; admin: boolean } }) {
  const today = todayIso();
  const month = monthOf(paramText(params.month), today);
  const from = `${month}-01`;
  const [{ rows, total }, categories] = await Promise.all([listPurchases(actor, { from, to: endOfMonth(from) }), purchaseCategories(actor)]);
  const fields: Field[] = [
    // Thêm mới: mặc định hôm nay nếu đang xem tháng này, không thì ngày đầu của tháng đang xem.
    { name: "purchasedAt", label: "Ngày mua", type: "date", required: true, defaultValue: today.startsWith(month) ? today : from },
    { name: "item", label: "Hạng mục mua", required: true },
    { name: "category", label: "Loại", required: true, suggestions: categories, hint: "Nhóm chi, vd. Thiết bị, Học cụ, Văn phòng phẩm." },
    { name: "quantity", label: "Số lượng", type: "number", required: true, defaultValue: "1" },
    { name: "unitPrice", label: "Đơn giá (đồng)", type: "money", required: true, hint: "Thành tiền = Số lượng × Đơn giá." },
  ];
  return (
    <div className="grid gap-4">
      <MonthForm tab="purchases" month={month} />
      <CrudSection
        title={`Mua sắm tháng ${monthLabel(month)}`}
        numbered
        centered={["Số lượng"]}
        columns={["Hạng mục", "Ngày mua", "Loại", "Số lượng", "Đơn giá", "Thành tiền"]}
        emptyText="Tháng này chưa có khoản mua sắm nào."
        rows={rows.map((p) => ({
          id: p.id,
          cells: [p.item, formatDate(p.purchasedAt), p.category, number(p.quantity), formatMoney(p.unitPrice), formatMoney(p.amount)],
          values: { purchasedAt: p.purchasedAt, item: p.item, category: p.category, quantity: String(p.quantity), unitPrice: String(p.unitPrice) },
        }))}
        fields={fields}
        createAction={perm.add ? createPurchaseAction : undefined}
        updateAction={perm.edit ? updatePurchaseAction : undefined}
        deleteAction={perm.admin ? deletePurchaseAction : undefined}
      />
      {rows.length > 0 && (
        <p className="text-sm font-semibold">
          Tổng mua sắm tháng {monthLabel(month)}: <span className="tabular-nums">{formatMoney(total)}</span>
        </p>
      )}
    </div>
  );
}

/** Học viên còn phải đóng học phí; xuất danh sách ra Excel/PDF. */
async function UnpaidTab({ actor, params }: { actor: Actor; params: Params }) {
  const classes = await listClasses(actor);
  // Chỉ nhận lớp có trong danh sách (tránh truy vấn với giá trị tùy ý).
  const current = classes.find((c) => c.id === paramText(params.classId)) ?? null;
  const { rows, total } = await unpaidTuition(actor, { classId: current?.id });
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <form className="min-w-0 flex-1 sm:max-w-sm">
          <input type="hidden" name="tab" value="unpaid" />
          <label className="grid gap-1.5 text-sm font-medium">
            Lớp học
            <AutoSubmitSelect name="classId" defaultValue={current?.id ?? ""}>
              <option value="">Tất cả lớp</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.code} – {c.name} ({LABELS.classStatus[c.status]})
                </option>
              ))}
            </AutoSubmitSelect>
          </label>
        </form>
        {rows.length > 0 && <ExportLinks label="Xuất danh sách" baseHref={`/api/export/unpaid-tuition${current ? `?classId=${current.id}` : ""}`} />}
      </div>
      <section className="grid gap-2">
        <h2 className="font-semibold">
          Học viên chưa đóng đủ học phí <span className="text-sm font-normal text-muted-foreground">({rows.length})</span>
        </h2>
        {rows.length === 0 ? (
          <p className={empty}>Không có học viên nào còn phải đóng học phí.</p>
        ) : (
          <div className="glass-solid min-w-0 overflow-x-auto rounded-2xl border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14 text-center">STT</TableHead>
                  <TableHead>Mã HV</TableHead>
                  <TableHead>Học viên</TableHead>
                  <TableHead>Lớp</TableHead>
                  <TableHead className="text-right">Phải đóng</TableHead>
                  <TableHead className="text-right">Đã đóng</TableHead>
                  <TableHead className="text-right">Còn lại</TableHead>
                  <TableHead>Trạng thái</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r, index) => (
                  <TableRow key={r.enrollmentId}>
                    <TableCell className="text-center text-muted-foreground tabular-nums">{index + 1}</TableCell>
                    <TableCell>{r.studentCode}</TableCell>
                    <TableCell className="whitespace-normal">{r.studentName}</TableCell>
                    <TableCell>{r.classCode}</TableCell>
                    <TableCell className="text-right tabular-nums">{number(r.due)}</TableCell>
                    <TableCell className="text-right tabular-nums">{number(r.paid)}</TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{number(r.remaining)}</TableCell>
                    <TableCell>
                      {TUITION_STATUS_LABEL[r.status]}
                      {r.enrollmentStatus === "left" && " · đã rời lớp"}
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow className="font-semibold">
                  <TableCell />
                  <TableCell />
                  <TableCell>Tổng cộng</TableCell>
                  <TableCell />
                  <TableCell className="text-right tabular-nums">{number(total.due)}</TableCell>
                  <TableCell className="text-right tabular-nums">{number(total.paid)}</TableCell>
                  <TableCell className="text-right tabular-nums">{number(total.remaining)}</TableCell>
                  <TableCell />
                </TableRow>
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}
