import { and, asc, between, desc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/db";
import { purchases, tuitionReceipts } from "@/db/schema";
import { type FinanceView, financePeriods, periodIndexOf } from "@/domain/finance";
import { TUITION_STATUS_LABEL } from "@/domain/tuition";
import { endOfMonth } from "@/lib/dates";
import { formatDate, todayIso } from "@/lib/format";
import type { PermissionAction } from "@/lib/permissions";
import type { purchaseInput } from "@/lib/validation/entities";
import { forbidden } from "../errors";
import type { ExportDoc } from "../export";
import { type Actor, assertCan, seesAllClasses } from "../guard";
import { createRow, deleteRow, updateRow } from "./crud";
import { timesheetForReport } from "./timesheet";
import { tuitionRows } from "./tuition";

// Báo cáo tài chính của cả trung tâm: doanh thu (phiếu thu học phí), chi (lương từ Chấm công + mua sắm), lãi.
// Số liệu của mọi lớp, mọi giáo viên nên ngoài quyền ở menu Báo cáo còn cần phạm vi "Tất cả lớp".

function assertFinance(actor: Actor, action: PermissionAction = "view") {
  assertCan(actor, "reports", action);
  if (!seesAllClasses(actor)) throw forbidden();
}

export type FinanceRow = {
  key: string;
  label: string;
  title: string;
  from: string;
  to: string;
  /** Doanh thu: phiếu thu học phí còn hiệu lực, theo ngày thu. */
  revenue: number;
  /** Chi lương: thành tiền các công đã dạy, theo ngày của dòng công. */
  salary: number;
  /** Mua sắm: số lượng × đơn giá, theo ngày mua. */
  purchases: number;
  expense: number;
  profit: number;
};

const emptyTotals = () => ({ revenue: 0, salary: 0, purchases: 0, expense: 0, profit: 0 });

/** Doanh thu – chi – lãi theo từng kỳ (tuần / tháng / năm) quanh ngày mốc, kèm tổng cả khoảng. */
export async function financeReport(actor: Actor, filters: { view: FinanceView; anchor: string }, now: Date = new Date()) {
  assertFinance(actor);
  const periods = financePeriods(filters.view, filters.anchor);
  const from = periods[0]!.from;
  const to = periods.at(-1)!.to;

  const [receiptRows, purchaseRows, timesheet] = await Promise.all([
    db
      .select({ date: tuitionReceipts.paidAt, amount: sql<number>`sum(${tuitionReceipts.amount})::float8` })
      .from(tuitionReceipts)
      .where(and(eq(tuitionReceipts.status, "active"), between(tuitionReceipts.paidAt, from, to)))
      .groupBy(tuitionReceipts.paidAt),
    db
      .select({ date: purchases.purchasedAt, amount: sql<number>`sum(${purchases.quantity}::bigint * ${purchases.unitPrice})::float8` })
      .from(purchases)
      .where(between(purchases.purchasedAt, from, to))
      .groupBy(purchases.purchasedAt),
    timesheetForReport(from, to, now),
  ]);

  const rows: FinanceRow[] = periods.map((p) => ({ ...p, ...emptyTotals() }));
  const add = (date: string, field: "revenue" | "salary" | "purchases", amount: number) => {
    const row = rows[periodIndexOf(periods, date)];
    if (row) row[field] += amount;
  };
  for (const r of receiptRows) add(r.date, "revenue", Number(r.amount));
  for (const p of purchaseRows) add(p.date, "purchases", Number(p.amount));
  let missingRate = 0;
  for (const t of timesheet.rows) {
    if (t.state !== "taught") continue;
    if (t.amount === null) missingRate += 1;
    else add(t.date, "salary", t.amount);
  }
  const total = emptyTotals();
  for (const row of rows) {
    row.expense = row.salary + row.purchases;
    row.profit = row.revenue - row.expense;
    total.revenue += row.revenue;
    total.salary += row.salary;
    total.purchases += row.purchases;
    total.expense += row.expense;
    total.profit += row.profit;
  }
  // `missingRate`: số công đã dạy chưa có mức lương nên chưa tính vào chi lương.
  return { view: filters.view, from, to, rows, total, missingRate };
}

/** Chi lương một tháng ("yyyy-mm"), từng giáo viên: lấy đúng số liệu Thành tiền của Chấm công. */
export async function salaryByTeacher(actor: Actor, month: string, now: Date = new Date()) {
  assertFinance(actor);
  const from = `${month}-01`;
  const to = endOfMonth(from);
  const { summary } = await timesheetForReport(from, to, now);
  const rows = summary.filter((s) => s.taught + s.assistant > 0).sort((a, b) => a.teacherCode.localeCompare(b.teacherCode));
  const total = rows.reduce(
    (sum, s) => ({ taught: sum.taught + s.taught, assistant: sum.assistant + s.assistant, amount: sum.amount + s.amount, missingRate: sum.missingRate + s.missingRate }),
    { taught: 0, assistant: 0, amount: 0, missingRate: 0 },
  );
  return { from, to, rows, total };
}

/** Các khoản mua sắm trong khoảng ngày (mới nhất trước), kèm thành tiền từng khoản và tổng. */
export async function listPurchases(actor: Actor, filters: { from: string; to: string }) {
  assertFinance(actor);
  const found = await db
    .select()
    .from(purchases)
    .where(between(purchases.purchasedAt, filters.from, filters.to))
    .orderBy(desc(purchases.purchasedAt), desc(purchases.createdAt));
  const rows = found.map((p) => ({ ...p, amount: p.quantity * p.unitPrice }));
  return { rows, total: rows.reduce((sum, p) => sum + p.amount, 0) };
}

/** Các loại (nhóm chi) đã nhập, để gợi ý khi gõ. */
export async function purchaseCategories(actor: Actor) {
  assertFinance(actor);
  const rows = await db.selectDistinct({ category: purchases.category }).from(purchases).orderBy(asc(purchases.category)).limit(100);
  return rows.map((r) => r.category);
}

export async function createPurchase(actor: Actor, data: z.output<typeof purchaseInput>) {
  assertFinance(actor, "add");
  return createRow(actor, purchases, "purchases", { ...data, createdBy: actor.userId }, "reports");
}

export async function updatePurchase(actor: Actor, id: string, data: z.output<typeof purchaseInput>) {
  assertFinance(actor, "edit");
  return updateRow(actor, purchases, "purchases", id, data, "reports");
}

export const deletePurchase = (actor: Actor, id: string) => deleteRow(actor, purchases, "purchases", id);

/** Học viên còn phải đóng học phí (chưa đóng hoặc đóng một phần) ở các lớp đã đặt học phí. */
export async function unpaidTuition(actor: Actor, filters: { classId?: string | null } = {}) {
  assertFinance(actor);
  const { rows: all } = await tuitionRows(null, { classId: filters.classId });
  const rows = all.filter((r) => r.status === "unpaid" || r.status === "partial");
  const total = rows.reduce((sum, r) => ({ due: sum.due + r.due, paid: sum.paid + r.paid, remaining: sum.remaining + r.remaining }), { due: 0, paid: 0, remaining: 0 });
  return { rows, total };
}

/**
 * Tệp danh sách học viên chưa đóng đủ học phí. Chỉ có mã, họ tên và số tiền:
 * không đưa điện thoại, phụ huynh, ngày sinh của học viên vào tệp.
 */
export async function unpaidTuitionDoc(actor: Actor, filters: { classId?: string | null } = {}): Promise<ExportDoc> {
  const { rows, total } = await unpaidTuition(actor, filters);
  const only = filters.classId ? rows[0]?.classCode : undefined;
  return {
    filename: `hoc-phi-chua-dong${only ? `-${only}` : ""}`,
    title: "Danh sách học viên chưa đóng đủ học phí",
    subtitle: `${only ? `Lớp ${only} · ` : ""}Lập ngày ${formatDate(todayIso())} · ${rows.length} học viên`,
    sections: [
      {
        title: "Chưa đóng học phí",
        columns: [
          { header: "STT", width: 6, align: "center" },
          { header: "Mã HV", width: 12 },
          { header: "Họ tên", width: 28 },
          { header: "Lớp", width: 16 },
          { header: "Phải đóng (đ)", width: 16, align: "right" },
          { header: "Đã đóng (đ)", width: 16, align: "right" },
          { header: "Còn lại (đ)", width: 16, align: "right" },
          { header: "Trạng thái", width: 16 },
          { header: "Ghi chú", width: 14 },
        ],
        rows: [
          ...rows.map((r, i) => [
            i + 1,
            r.studentCode,
            r.studentName,
            r.classCode,
            r.due,
            r.paid,
            r.remaining,
            TUITION_STATUS_LABEL[r.status],
            r.enrollmentStatus === "left" ? "Đã rời lớp" : "",
          ]),
          ...(rows.length > 0 ? [["", "", "Tổng cộng", "", total.due, total.paid, total.remaining, "", ""]] : []),
        ],
      },
    ],
  };
}
