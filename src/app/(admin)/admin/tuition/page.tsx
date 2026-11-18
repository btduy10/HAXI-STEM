import type { Metadata } from "next";
import { ConfirmButton, FormDialogButton } from "@/components/action-buttons";
import { AutoSubmitSelect } from "@/components/auto-submit-select";
import type { Field } from "@/components/form-dialog";
import { LinkButton } from "@/components/link-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PAYMENT_METHOD_LABEL, TUITION_STATUS_LABEL, type TuitionStatus } from "@/domain/tuition";
import { LABELS, formatDate, formatMoney, todayIso } from "@/lib/format";
import { cn } from "@/lib/utils";
import { paramText } from "@/lib/search-params";
import { cancelReceiptAction, createReceiptAction, deleteReceiptAction, setClassFeeAction, setDiscountAction } from "@/server/actions/admin";
import { listClassFees, listReceipts, listTuition } from "@/server/services/tuition";
import { requireMenu } from "@/server/session";

export const metadata: Metadata = { title: "Học phí" };

/** Mức học phí gợi ý sẵn khi đặt học phí cho lớp chưa có (đồng/khóa). */
const DEFAULT_TUITION_FEE = 2_000_000;

const STATUSES: TuitionStatus[] = ["unpaid", "partial", "paid", "unset"];
const STATUS_VARIANT: Record<TuitionStatus, "default" | "secondary" | "destructive" | "outline"> = {
  unset: "outline",
  unpaid: "destructive",
  partial: "secondary",
  paid: "default",
};

export default async function TuitionPage({ searchParams }: PageProps<"/admin/tuition">) {
  const { actor, role, can } = await requireMenu("tuition");
  const params = await searchParams;
  const classes = await listClassFees(actor);
  // Chỉ nhận lớp và trạng thái có trong danh sách (tránh truy vấn với giá trị tùy ý).
  const cls = classes.find((c) => c.id === paramText(params.classId)) ?? null;
  const status = STATUSES.find((s) => s === paramText(params.status)) ?? null;
  const q = paramText(params.q);
  const [{ rows, total }, receipts] = await Promise.all([
    listTuition(actor, { classId: cls?.id, status, q }),
    listReceipts(actor, { classId: cls?.id }, cls ? 200 : 30),
  ]);
  const today = todayIso();

  const receiptFields = (remaining: number): Field[] => [
    { name: "amount", label: "Số tiền thu (đồng)", type: "money", required: true, hint: `Còn phải đóng ${formatMoney(remaining)}.` },
    {
      name: "method",
      label: "Hình thức",
      type: "select",
      required: true,
      defaultValue: "cash",
      options: Object.entries(PAYMENT_METHOD_LABEL).map(([value, label]) => ({ value, label })),
    },
    { name: "paidAt", label: "Ngày thu", type: "date", required: true },
    { name: "payerName", label: "Người nộp", hint: "Tên phụ huynh nộp tiền (in trên phiếu thu)." },
    { name: "note", label: "Ghi chú" },
  ];
  const discountFields: Field[] = [
    { name: "discount", label: "Giảm học phí (đồng)", type: "money", required: true, hint: "Nhập 0 để bỏ giảm." },
    { name: "reason", label: "Lý do", hint: "Vd. anh chị em, học bổng." },
  ];

  const rowActions = (r: (typeof rows)[number]) => (
    <div className="flex flex-wrap items-center gap-1">
      {can("add") && r.remaining > 0 && (
        <FormDialogButton
          label="Thu tiền"
          title={`Thu học phí – ${r.studentName}`}
          description={`${r.classCode} – ${r.className}`}
          fields={receiptFields(r.remaining)}
          initial={{ amount: String(r.remaining), method: "cash", paidAt: today }}
          fixed={{ enrollmentId: r.enrollmentId }}
          action={createReceiptAction}
          successMessage="Đã lập phiếu thu."
          className="h-9"
        />
      )}
      {can("edit") && r.status !== "unset" && (
        <FormDialogButton
          label="Giảm"
          title={`Giảm học phí – ${r.studentName}`}
          fields={discountFields}
          initial={{ discount: String(r.discount), reason: r.discountReason ?? "" }}
          fixed={{ enrollmentId: r.enrollmentId }}
          action={setDiscountAction}
          variant="outline"
          className="h-9"
        />
      )}
      {r.status !== "unset" && (
        <LinkButton variant="outline" className="h-9" href={`/admin/tuition/notice?enrollmentId=${r.enrollmentId}`}>
          Giấy báo
        </LinkButton>
      )}
    </div>
  );

  return (
    <div className="grid gap-4">
      <h1 className="text-xl font-semibold sm:text-2xl">Học phí</h1>

      <form className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]" role="search">
        <AutoSubmitSelect name="classId" defaultValue={cls?.id ?? ""} aria-label="Lọc theo lớp" className="h-10">
          <option value="">Tất cả lớp</option>
          {classes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} – {c.name} ({LABELS.classStatus[c.status]})
            </option>
          ))}
        </AutoSubmitSelect>
        <AutoSubmitSelect name="status" defaultValue={status ?? ""} aria-label="Lọc theo trạng thái" className="h-10">
          <option value="">Tất cả trạng thái</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {TUITION_STATUS_LABEL[s]}
            </option>
          ))}
        </AutoSubmitSelect>
        <Input name="q" defaultValue={q} placeholder="Tìm mã hoặc tên học viên" aria-label="Tìm học viên" className="h-10" />
        <Button type="submit" variant="outline" className="h-10">
          Tìm
        </Button>
      </form>

      {cls && (
        <div className="flex flex-wrap items-center gap-2 glass-solid rounded-xl border p-3 text-sm">
          <span>
            Học phí lớp <strong>{cls.code}</strong>:{" "}
            <strong>{cls.tuitionFee === null ? "chưa đặt" : `${formatMoney(cls.tuitionFee)} / học viên`}</strong>
          </span>
          {can("edit") && (
            <FormDialogButton
              label="Đặt học phí"
              title={`Học phí lớp ${cls.code}`}
              fields={[
                {
                  name: "tuitionFee",
                  label: "Học phí (đồng/khóa)",
                  type: "money",
                  hint: "Học phí cả khóa của mỗi học viên. Để trống = chưa đặt học phí.",
                },
              ]}
              // Lớp chưa đặt học phí: gợi ý sẵn mức mặc định, Admin sửa lại nếu khác.
              initial={{ tuitionFee: String(cls.tuitionFee ?? DEFAULT_TUITION_FEE) }}
              fixed={{ classId: cls.id }}
              action={setClassFeeAction}
              variant="outline"
              className="h-9"
            />
          )}
          {cls.tuitionFee !== null && (
            <>
              <LinkButton variant="outline" className="h-9" href={`/admin/tuition/notice?classId=${cls.id}&unpaidOnly=1`}>
                In giấy báo (chưa đóng đủ)
              </LinkButton>
              <LinkButton variant="outline" className="h-9" href={`/admin/tuition/notice?classId=${cls.id}`}>
                In giấy báo cả lớp
              </LinkButton>
            </>
          )}
        </div>
      )}
      {!cls && <p className="text-sm text-muted-foreground">Chọn một lớp để đặt học phí của lớp và in giấy báo học phí cho cả lớp.</p>}

      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {[
          ["Phải thu", total.due],
          ["Đã thu", total.paid],
          ["Còn phải thu", total.remaining],
        ].map(([label, value]) => (
          <div key={label} className="glass-solid rounded-2xl border p-3">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatMoney(value as number)}</dd>
          </div>
        ))}
      </dl>

      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">
          Học viên <span className="text-sm font-normal text-muted-foreground">({rows.length})</span>
        </h2>
        {rows.length === 0 ? (
          <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">Không có học viên phù hợp.</p>
        ) : (
          <>
            <ul className="grid gap-2 lg:hidden">
              {rows.map((r, index) => (
                <li key={r.enrollmentId} className="grid gap-2 glass-solid rounded-xl border p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-muted-foreground tabular-nums">{index + 1}.</span>
                    <span className="font-medium">
                      {r.studentCode} – {r.studentName}
                    </span>
                    <Badge variant={STATUS_VARIANT[r.status]}>{TUITION_STATUS_LABEL[r.status]}</Badge>
                  </div>
                  <p className="text-muted-foreground">
                    {r.className}
                    {r.enrollmentStatus === "left" && " · đã rời lớp"}
                  </p>
                  {r.status !== "unset" && (
                    <p className="tabular-nums">
                      Phải đóng {formatMoney(r.due)}
                      {r.discount > 0 && ` (đã giảm ${formatMoney(r.discount)})`} · Đã đóng {formatMoney(r.paid)} · Còn lại{" "}
                      <strong>{formatMoney(r.remaining)}</strong>
                    </p>
                  )}
                  {rowActions(r)}
                </li>
              ))}
            </ul>
            <div className="glass-solid hidden min-w-0 overflow-hidden rounded-2xl border lg:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12 text-center">STT</TableHead>
                    <TableHead>Mã HV</TableHead>
                    <TableHead>Học viên</TableHead>
                    <TableHead>Lớp</TableHead>
                    <TableHead className="text-right">Học phí</TableHead>
                    <TableHead className="text-right">Giảm</TableHead>
                    <TableHead className="text-right">Phải đóng</TableHead>
                    <TableHead className="text-right">Đã đóng</TableHead>
                    <TableHead className="text-right">Còn lại</TableHead>
                    <TableHead>Trạng thái</TableHead>
                    <TableHead className="w-0" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r, index) => (
                    <TableRow key={r.enrollmentId}>
                      <TableCell className="text-center text-muted-foreground tabular-nums">{index + 1}</TableCell>
                      <TableCell>{r.studentCode}</TableCell>
                      <TableCell className="font-medium whitespace-normal">{r.studentName}</TableCell>
                      <TableCell className="whitespace-normal">
                        {r.className}
                        {r.enrollmentStatus === "left" && <span className="block text-xs text-muted-foreground">đã rời lớp</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.fee === null ? "—" : formatMoney(r.fee)}</TableCell>
                      <TableCell className="text-right tabular-nums" title={r.discountReason ?? undefined}>
                        {r.discount > 0 ? formatMoney(r.discount) : ""}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.status === "unset" ? "—" : formatMoney(r.due)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(r.paid)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{r.status === "unset" ? "—" : formatMoney(r.remaining)}</TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[r.status]}>{TUITION_STATUS_LABEL[r.status]}</Badge>
                      </TableCell>
                      <TableCell>{rowActions(r)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </section>

      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">
          Phiếu thu đã lập{" "}
          <span className="text-sm font-normal text-muted-foreground">({cls ? receipts.length : `${receipts.length} phiếu gần nhất`})</span>
        </h2>
        {receipts.length === 0 ? (
          <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">Chưa có phiếu thu.</p>
        ) : (
          <ul className="grid gap-2">
            {receipts.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 glass-solid rounded-xl border p-3 text-sm">
                <div className={cn("min-w-0", r.status === "cancelled" && "text-muted-foreground line-through")}>
                  <p className="font-medium">
                    {r.code} · {formatDate(r.paidAt)} · <span className="tabular-nums">{formatMoney(r.amount)}</span> · {PAYMENT_METHOD_LABEL[r.method]}
                  </p>
                  <p className="text-muted-foreground">
                    {r.studentCode} – {r.studentName} · {r.className}
                    {r.collectorName && ` · người thu: ${r.collectorName}`}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {r.status === "cancelled" ? (
                    <>
                      <Badge variant="destructive" title={r.cancelReason ?? undefined}>
                        Đã hủy
                      </Badge>
                      {role === "admin" && (
                        <ConfirmButton
                          label="Xóa"
                          confirmText={`Xóa hẳn phiếu thu đã hủy ${r.code}? Thao tác này không hoàn tác được.`}
                          action={deleteReceiptAction}
                          input={{ id: r.id }}
                          successMessage="Đã xóa phiếu thu."
                          className="h-9"
                        />
                      )}
                    </>
                  ) : (
                    <>
                      <LinkButton variant="outline" className="h-9" href={`/admin/tuition/receipts/${r.id}`}>
                        In phiếu
                      </LinkButton>
                      {role === "admin" && (
                        <FormDialogButton
                          label="Hủy"
                          title={`Hủy phiếu thu ${r.code}`}
                          description="Phiếu hủy được giữ lại để đối chiếu nhưng không còn tính là đã đóng."
                          fields={[{ name: "reason", label: "Lý do hủy", required: true }]}
                          fixed={{ id: r.id }}
                          action={cancelReceiptAction}
                          variant="outline"
                          submitLabel="Hủy phiếu"
                          successMessage="Đã hủy phiếu thu."
                          className="h-9"
                        />
                      )}
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
