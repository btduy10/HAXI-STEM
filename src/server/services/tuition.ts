import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/db";
import { appSettings, classes, enrollments, students, tuitionReceipts, user } from "@/db/schema";
import { type TuitionStatus, receiptCode, tuitionBalance } from "@/domain/tuition";
import type { centerInfoInput } from "@/lib/validation/rewards";
import type { cancelReceiptInput, classFeeInput, discountInput, receiptInput } from "@/lib/validation/tuition";
import { audit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, allowedClassIds, assertAdmin, assertCan, assertClassAccess, assertNotTimetableOnly } from "../guard";
import { CENTER_INFO_KEY, getCenterInfo } from "../settings";

// Học phí: mức theo lớp, giảm riêng theo lượt ghi danh, mỗi lần thu là một phiếu thu.
// Giấy in chỉ dùng tên và mã học viên; không đọc ngày sinh, điện thoại, phụ huynh từ hồ sơ.

/** Tổng tiền các phiếu còn hiệu lực của từng lượt ghi danh. */
const paidByEnrollment = db
  .select({
    enrollmentId: tuitionReceipts.enrollmentId,
    paid: sql<number>`coalesce(sum(${tuitionReceipts.amount}), 0)::int`.as("paid"),
  })
  .from(tuitionReceipts)
  .where(eq(tuitionReceipts.status, "active"))
  .groupBy(tuitionReceipts.enrollmentId)
  .as("paid_by_enrollment");

export type TuitionFilters = { classId?: string | null; status?: TuitionStatus | null; q?: string | null; enrollmentId?: string | null };

/** Mỗi lượt ghi danh một dòng: phải đóng, đã đóng, còn lại, trạng thái. Giới hạn theo phạm vi lớp của người xem. */
export async function listTuition(actor: Actor, filters: TuitionFilters = {}) {
  assertCan(actor, "tuition", "view");
  return tuitionRows(await allowedClassIds(actor), filters);
}

/**
 * Truy vấn học phí theo lượt ghi danh, KHÔNG kiểm quyền: hàm gọi phải tự kiểm (menu Học phí hoặc Báo cáo).
 * `allowed` = danh sách lớp được xem, null = mọi lớp.
 */
export async function tuitionRows(allowed: string[] | null, filters: TuitionFilters = {}) {
  const zero = { due: 0, paid: 0, remaining: 0 };
  if (allowed && allowed.length === 0) return { rows: [], total: zero };
  const conditions = [];
  if (allowed) conditions.push(inArray(enrollments.classId, allowed));
  if (filters.classId) conditions.push(eq(enrollments.classId, filters.classId));
  if (filters.enrollmentId) conditions.push(eq(enrollments.id, filters.enrollmentId));

  const found = await db
    .select({
      enrollmentId: enrollments.id,
      enrollmentStatus: enrollments.status,
      studentCode: students.code,
      studentName: students.fullName,
      classId: classes.id,
      classCode: classes.code,
      className: classes.name,
      classStart: classes.startDate,
      classEnd: classes.endDate,
      fee: classes.tuitionFee,
      discount: enrollments.feeDiscount,
      discountReason: enrollments.feeDiscountReason,
      paid: sql<number>`coalesce(${paidByEnrollment.paid}, 0)::int`,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .innerJoin(classes, eq(classes.id, enrollments.classId))
    .leftJoin(paidByEnrollment, eq(paidByEnrollment.enrollmentId, enrollments.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(classes.code), asc(students.code));

  const q = filters.q?.trim().toLowerCase();
  const rows = found
    .map((r) => ({ ...r, ...tuitionBalance(r.fee, r.discount, r.paid) }))
    .filter((r) => (!filters.status || r.status === filters.status) && (!q || `${r.studentCode} ${r.studentName}`.toLowerCase().includes(q)));
  const total = rows.reduce((sum, r) => ({ due: sum.due + r.due, paid: sum.paid + r.paid, remaining: sum.remaining + r.remaining }), zero);
  return { rows, total };
}

/** Học phí của các lớp trong phạm vi người xem. */
export async function listClassFees(actor: Actor) {
  assertCan(actor, "tuition", "view");
  const allowed = await allowedClassIds(actor);
  if (allowed && allowed.length === 0) return [];
  return db
    .select({ id: classes.id, code: classes.code, name: classes.name, status: classes.status, tuitionFee: classes.tuitionFee })
    .from(classes)
    .where(and(eq(classes.timetableOnly, false), allowed ? inArray(classes.id, allowed) : undefined))
    .orderBy(desc(classes.startDate), asc(classes.code));
}

export async function setClassFee(actor: Actor, data: z.output<typeof classFeeInput>) {
  assertCan(actor, "tuition", "edit");
  await assertClassAccess(actor, data.classId);
  await assertNotTimetableOnly(data.classId);
  await db.transaction(async (tx) => {
    const [before] = await tx.select({ tuitionFee: classes.tuitionFee }).from(classes).where(eq(classes.id, data.classId)).for("update").limit(1);
    if (!before) throw notFound("lớp học");
    await tx.update(classes).set({ tuitionFee: data.tuitionFee, updatedAt: new Date() }).where(eq(classes.id, data.classId));
    await audit(tx, {
      userId: actor.userId,
      action: "class_fee_updated",
      tableName: "classes",
      recordId: data.classId,
      oldValue: before,
      newValue: { tuitionFee: data.tuitionFee },
    });
  });
}

export async function setDiscount(actor: Actor, data: z.output<typeof discountInput>) {
  assertCan(actor, "tuition", "edit");
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(enrollments).where(eq(enrollments.id, data.enrollmentId)).for("update").limit(1);
    if (!before) throw notFound("ghi danh");
    await assertClassAccess(actor, before.classId, tx);
    const [cls] = await tx.select({ fee: classes.tuitionFee }).from(classes).where(eq(classes.id, before.classId)).limit(1);
    if (cls?.fee === null || cls?.fee === undefined) throw new AppError("CONFLICT", "Lớp chưa đặt học phí nên chưa nhập được mức giảm.");
    if (data.discount > cls.fee) {
      throw new AppError("VALIDATION", "Mức giảm không được lớn hơn học phí của lớp.", { discount: "Lớn hơn học phí của lớp" });
    }
    const reason = data.discount > 0 ? data.reason : null;
    await tx.update(enrollments).set({ feeDiscount: data.discount, feeDiscountReason: reason, updatedAt: new Date() }).where(eq(enrollments.id, before.id));
    await audit(tx, {
      userId: actor.userId,
      action: "tuition_discount_updated",
      tableName: "enrollments",
      recordId: before.id,
      oldValue: { feeDiscount: before.feeDiscount, feeDiscountReason: before.feeDiscountReason },
      newValue: { feeDiscount: data.discount, feeDiscountReason: reason },
    });
  });
}

/** Lập phiếu thu. Không thu vượt số còn phải đóng; lớp phải đã đặt học phí. */
export async function createReceipt(actor: Actor, data: z.output<typeof receiptInput>) {
  assertCan(actor, "tuition", "add");
  return db.transaction(async (tx) => {
    // Khóa lượt ghi danh để hai người thu cùng lúc không vượt số còn lại.
    const [enrollment] = await tx.select().from(enrollments).where(eq(enrollments.id, data.enrollmentId)).for("update").limit(1);
    if (!enrollment) throw notFound("ghi danh");
    await assertClassAccess(actor, enrollment.classId, tx);
    const [cls] = await tx.select({ fee: classes.tuitionFee }).from(classes).where(eq(classes.id, enrollment.classId)).limit(1);
    if (cls?.fee === null || cls?.fee === undefined) throw new AppError("CONFLICT", "Lớp chưa đặt học phí. Hãy đặt học phí của lớp trước khi thu.");
    const [sum] = await tx
      .select({ paid: sql<number>`coalesce(sum(${tuitionReceipts.amount}), 0)::int` })
      .from(tuitionReceipts)
      .where(and(eq(tuitionReceipts.enrollmentId, enrollment.id), eq(tuitionReceipts.status, "active")));
    const { remaining } = tuitionBalance(cls.fee, enrollment.feeDiscount, sum?.paid ?? 0);
    if (remaining === 0) throw new AppError("CONFLICT", "Học viên đã đóng đủ học phí của lớp này.");
    if (data.amount > remaining) {
      const message = `Số tiền thu lớn hơn số còn phải đóng (${remaining.toLocaleString("vi-VN")} đ).`;
      throw new AppError("VALIDATION", message, { amount: message });
    }
    const [row] = await tx
      .insert(tuitionReceipts)
      .values({ ...data, collectedBy: actor.userId })
      .returning();
    await audit(tx, {
      userId: actor.userId,
      action: "tuition_receipt_created",
      tableName: "tuition_receipts",
      recordId: row!.id,
      newValue: { receiptNo: row!.receiptNo, enrollmentId: row!.enrollmentId, amount: row!.amount, method: row!.method, paidAt: row!.paidAt },
    });
    return { id: row!.id, code: receiptCode(row!.receiptNo) };
  });
}

/** Hủy phiếu thu ghi nhầm (chỉ Admin). Phiếu được giữ lại để đối chiếu nhưng không còn tính là đã đóng. */
export async function cancelReceipt(actor: Actor, data: z.output<typeof cancelReceiptInput>) {
  assertAdmin(actor);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(tuitionReceipts).where(eq(tuitionReceipts.id, data.id)).for("update").limit(1);
    if (!before) throw notFound("phiếu thu");
    if (before.status === "cancelled") throw new AppError("CONFLICT", "Phiếu thu này đã bị hủy.");
    await tx
      .update(tuitionReceipts)
      .set({ status: "cancelled", cancelledAt: new Date(), cancelledBy: actor.userId, cancelReason: data.reason })
      .where(eq(tuitionReceipts.id, data.id));
    await audit(tx, {
      userId: actor.userId,
      action: "tuition_receipt_cancelled",
      tableName: "tuition_receipts",
      recordId: data.id,
      oldValue: { receiptNo: before.receiptNo, amount: before.amount },
      newValue: { reason: data.reason },
    });
  });
}

/** Xóa hẳn một phiếu thu ĐÃ HỦY (chỉ Admin). Phiếu còn hiệu lực phải hủy trước; nội dung phiếu bị xóa được ghi vào nhật ký. */
export async function deleteReceipt(actor: Actor, id: string) {
  assertAdmin(actor);
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(tuitionReceipts).where(eq(tuitionReceipts.id, id)).for("update").limit(1);
    if (!before) throw notFound("phiếu thu");
    if (before.status !== "cancelled") throw new AppError("CONFLICT", "Chỉ xóa được phiếu thu đã hủy. Hãy hủy phiếu trước.");
    await tx.delete(tuitionReceipts).where(eq(tuitionReceipts.id, id));
    await audit(tx, {
      userId: actor.userId,
      action: "tuition_receipt_deleted",
      tableName: "tuition_receipts",
      recordId: id,
      oldValue: {
        receiptNo: before.receiptNo,
        enrollmentId: before.enrollmentId,
        amount: before.amount,
        method: before.method,
        paidAt: before.paidAt,
        cancelReason: before.cancelReason,
      },
    });
  });
}

const receiptSelection = {
  id: tuitionReceipts.id,
  receiptNo: tuitionReceipts.receiptNo,
  enrollmentId: tuitionReceipts.enrollmentId,
  amount: tuitionReceipts.amount,
  method: tuitionReceipts.method,
  paidAt: tuitionReceipts.paidAt,
  payerName: tuitionReceipts.payerName,
  note: tuitionReceipts.note,
  status: tuitionReceipts.status,
  cancelReason: tuitionReceipts.cancelReason,
  collectorName: user.name,
  studentCode: students.code,
  studentName: students.fullName,
  classId: classes.id,
  classCode: classes.code,
  className: classes.name,
};
const receiptBase = () =>
  db
    .select(receiptSelection)
    .from(tuitionReceipts)
    .innerJoin(enrollments, eq(enrollments.id, tuitionReceipts.enrollmentId))
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .innerJoin(classes, eq(classes.id, enrollments.classId))
    .leftJoin(user, eq(user.id, tuitionReceipts.collectedBy));

/** Phiếu thu đã lập (mới nhất trước), trong phạm vi lớp của người xem. */
export async function listReceipts(actor: Actor, filters: { classId?: string | null } = {}, limit = 200) {
  assertCan(actor, "tuition", "view");
  const allowed = await allowedClassIds(actor);
  if (allowed && allowed.length === 0) return [];
  const conditions = [];
  if (allowed) conditions.push(inArray(classes.id, allowed));
  if (filters.classId) conditions.push(eq(classes.id, filters.classId));
  const rows = await receiptBase()
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(tuitionReceipts.receiptNo))
    .limit(limit);
  return rows.map((r) => ({ ...r, code: receiptCode(r.receiptNo) }));
}

/** Một phiếu thu để in, kèm tình hình học phí hiện tại của lượt ghi danh và thông tin trung tâm. */
export async function getReceipt(actor: Actor, id: string) {
  assertCan(actor, "tuition", "view");
  const [row] = await receiptBase().where(eq(tuitionReceipts.id, id)).limit(1);
  if (!row) throw notFound("phiếu thu");
  await assertClassAccess(actor, row.classId);
  const [{ rows }, center] = await Promise.all([listTuition(actor, { enrollmentId: row.enrollmentId }), getCenterInfo()]);
  return { receipt: { ...row, code: receiptCode(row.receiptNo) }, balance: rows[0] ?? null, center };
}

/**
 * Giấy báo học phí: một lượt ghi danh, hoặc cả lớp (chỉ học viên đang học; `unpaidOnly` bỏ qua em đã đóng đủ).
 * Lớp chưa đặt học phí thì không có giấy báo.
 */
export async function getFeeNotices(actor: Actor, filters: { enrollmentId?: string | null; classId?: string | null; unpaidOnly?: boolean }) {
  const center = await getCenterInfo();
  if (!filters.enrollmentId && !filters.classId) {
    assertCan(actor, "tuition", "view");
    return { notices: [], center };
  }
  const { rows } = await listTuition(actor, { enrollmentId: filters.enrollmentId, classId: filters.classId });
  const priced = rows.filter((r) => r.status !== "unset");
  const notices = filters.enrollmentId
    ? priced
    : priced.filter((r) => r.enrollmentStatus === "active" && (!filters.unpaidOnly || r.status !== "paid"));
  return { notices, center };
}

export async function readCenterInfo(actor: Actor) {
  assertAdmin(actor);
  return getCenterInfo();
}

export async function updateCenterInfo(actor: Actor, data: z.output<typeof centerInfoInput>) {
  assertAdmin(actor);
  const value = { name: data.name, address: data.address ?? "", phone: data.phone ?? "", bank: data.bank ?? "" };
  await db.transaction(async (tx) => {
    const before = await getCenterInfo(tx);
    await tx
      .insert(appSettings)
      .values({ key: CENTER_INFO_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
    await audit(tx, { userId: actor.userId, action: "center_info_updated", tableName: "app_settings", oldValue: before, newValue: value });
  });
  return value;
}
