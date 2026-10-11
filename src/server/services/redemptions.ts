import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { classes, enrollments, giftRedemptions, gifts, starLogs, students, user } from "@/db/schema";
import { audit } from "../audit";
import { AppError, notFound } from "../errors";
import { type Actor, allowedClassIds, assertAdmin, assertCan, can } from "../guard";
import { assertStudentAccess } from "./stars";
import { tiersFor } from "./summaries";

// Đổi quà trong khóa học: học viên đủ "sao còn lại" theo Mốc quà thì đổi được, bất cứ lúc nào.
// Sao còn lại = tổng sao tích lũy − số sao đã dùng đổi quà. Tổng tích lũy không giảm khi đổi quà.

/** Số sao đã dùng đổi quà của một học viên. */
async function spentOf(tx: DbOrTx, studentId: string): Promise<number> {
  const [row] = await tx
    .select({ spent: sql<number>`coalesce(sum(${giftRedemptions.stars}), 0)::int` })
    .from(giftRedemptions)
    .where(eq(giftRedemptions.studentId, studentId));
  return row?.spent ?? 0;
}

async function totalOf(tx: DbOrTx, studentId: string): Promise<number> {
  const [row] = await tx
    .select({ sum: sql<number>`coalesce(sum(${starLogs.stars}), 0)::int` })
    .from(starLogs)
    .where(eq(starLogs.studentId, studentId));
  return Math.max(0, row?.sum ?? 0);
}

/** Các mốc quà học viên đổi được: mốc của những lớp đang mở mà em đang học, trong phạm vi của người dùng. */
async function redeemableTiers(tx: DbOrTx, actor: Actor, studentId: string) {
  const allowed = await allowedClassIds(actor, tx);
  if (allowed && allowed.length === 0) return [];
  const active = await tx
    .select({ id: classes.id, code: classes.code })
    .from(enrollments)
    .innerJoin(classes, eq(classes.id, enrollments.classId))
    .where(
      and(
        eq(enrollments.studentId, studentId),
        eq(enrollments.status, "active"),
        eq(classes.status, "open"),
        allowed ? inArray(classes.id, allowed) : undefined,
      ),
    )
    .orderBy(asc(classes.code));
  const out: { tierId: string; classId: string; classCode: string; giftId: string; minStars: number }[] = [];
  // Mốc quà đặt theo lớp: mỗi lớp em đang học dùng mốc của chính lớp đó.
  for (const cls of active) {
    for (const tier of await tiersFor(tx, cls)) {
      out.push({ tierId: tier.id, classId: cls.id, classCode: cls.code, giftId: tier.giftId, minStars: tier.minStars });
    }
  }
  return out;
}

/** Tình trạng đổi quà của một học viên: sao còn lại, các lần đã đổi, các mốc đổi được. Gọi sau khi đã kiểm tra quyền xem học viên. */
export async function getRedemptionInfo(actor: Actor, studentId: string) {
  const [total, spent, history, tiers] = await Promise.all([
    totalOf(db, studentId),
    spentOf(db, studentId),
    db
      .select({
        id: giftRedemptions.id,
        giftName: gifts.name,
        classCode: classes.code,
        stars: giftRedemptions.stars,
        redeemedAt: giftRedemptions.redeemedAt,
        redeemedByName: user.name,
      })
      .from(giftRedemptions)
      .innerJoin(gifts, eq(gifts.id, giftRedemptions.giftId))
      .leftJoin(classes, eq(classes.id, giftRedemptions.classId))
      .leftJoin(user, eq(user.id, giftRedemptions.redeemedBy))
      .where(eq(giftRedemptions.studentId, studentId))
      .orderBy(desc(giftRedemptions.redeemedAt)),
    can(actor, "rewards", "edit") ? redeemableTiers(db, actor, studentId) : [],
  ]);
  const giftRows = tiers.length ? await db.select().from(gifts).where(inArray(gifts.id, [...new Set(tiers.map((t) => t.giftId))])) : [];
  const giftOf = new Map(giftRows.map((g) => [g.id, g]));
  const balance = Math.max(0, total - spent);
  return {
    total,
    spent,
    balance,
    history,
    /** Mốc quà đổi được ngay: đủ sao còn lại và kho còn quà. Rỗng nếu người dùng không có quyền đổi quà. */
    options: tiers
      .map((t) => ({ ...t, giftName: giftOf.get(t.giftId)?.name ?? "?", stock: giftOf.get(t.giftId)?.stock ?? 0 }))
      .filter((t) => t.minStars <= balance && t.stock > 0)
      .sort((a, b) => a.minStars - b.minStars),
    canRedeem: can(actor, "rewards", "edit"),
  };
}

/** Đổi quà theo một mốc quà: trừ sao còn lại đúng bằng mốc sao, trừ tồn kho. Cần quyền Sửa ở menu Quà & Tổng kết. */
export async function redeemGift(actor: Actor, data: { studentId: string; tierId: string }, now: Date = new Date()) {
  assertCan(actor, "rewards", "edit");
  return db.transaction(async (tx) => {
    await assertStudentAccess(actor, data.studentId, tx, now);
    // Khóa dòng học viên để hai lần đổi cùng lúc không tiêu trùng sao.
    const [student] = await tx.select({ id: students.id }).from(students).where(eq(students.id, data.studentId)).for("update").limit(1);
    if (!student) throw notFound("học viên");
    const tier = (await redeemableTiers(tx, actor, data.studentId)).find((t) => t.tierId === data.tierId);
    if (!tier) throw new AppError("VALIDATION", "Mốc quà này không áp dụng cho lớp học viên đang học.", { tierId: "Không áp dụng" });

    const [total, spent] = await Promise.all([totalOf(tx, data.studentId), spentOf(tx, data.studentId)]);
    const balance = Math.max(0, total - spent);
    if (balance < tier.minStars) {
      throw new AppError("CONFLICT", `Học viên còn ${balance} sao, chưa đủ ${tier.minStars} sao để đổi quà này.`);
    }
    const [gift] = await tx.select().from(gifts).where(eq(gifts.id, tier.giftId)).for("update").limit(1);
    if (!gift || gift.stock < 1) throw new AppError("CONFLICT", `Kho đã hết quà "${gift?.name ?? "?"}". Hãy cập nhật tồn kho trước.`);
    await tx.update(gifts).set({ stock: gift.stock - 1 }).where(eq(gifts.id, gift.id));
    const [row] = await tx
      .insert(giftRedemptions)
      .values({ studentId: data.studentId, classId: tier.classId, giftId: gift.id, stars: tier.minStars, redeemedBy: actor.userId, redeemedAt: now })
      .returning();
    await audit(tx, { userId: actor.userId, action: "gift_redeemed", tableName: "gift_redemptions", recordId: row!.id, newValue: row });
    return { ...row!, giftName: gift.name, balance: balance - tier.minStars };
  });
}

/** Hủy một lần đổi quà ghi nhầm (chỉ Admin): trả lại sao và tồn kho. */
export async function cancelRedemption(actor: Actor, id: string) {
  assertAdmin(actor);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(giftRedemptions).where(eq(giftRedemptions.id, id)).for("update").limit(1);
    if (!before) throw notFound("lần đổi quà");
    await tx.update(gifts).set({ stock: sql`${gifts.stock} + 1` }).where(eq(gifts.id, before.giftId));
    await tx.delete(giftRedemptions).where(eq(giftRedemptions.id, id));
    await audit(tx, { userId: actor.userId, action: "gift_redemption_cancelled", tableName: "gift_redemptions", recordId: id, oldValue: before });
  });
}
