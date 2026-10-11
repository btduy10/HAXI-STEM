import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { giftRedemptions, gifts, rewardTiers, sessions, starLogs } from "@/db/schema";
import { DEFAULT_PERMISSIONS, type RolePermissions } from "@/lib/permissions";
import type { Actor } from "@/server/guard";
import * as redemptions from "@/server/services/redemptions";
import * as stars from "@/server/services/stars";
import { type Fixture, resetDb, seedFixture } from "./helpers";

let f: Fixture;
let tier10: string;
let tier30: string;
let giftId: string;
const a1 = () => f.students[0]!.id;

/** Vai trò Giáo viên được tick thêm quyền Sửa ở menu Quà & Tổng kết. */
const withRewards = (actor: Actor): Actor => {
  const base = DEFAULT_PERMISSIONS.teacher!;
  const perms: RolePermissions = { ...base, menus: { ...base.menus, rewards: { view: true, add: false, edit: true } } };
  return { ...actor, perms };
};

beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  const [sticker, kit] = await db
    .insert(gifts)
    .values([
      { name: "Sticker", stock: 2 },
      { name: "Bộ lắp ráp", stock: 0 },
    ])
    .returning();
  giftId = sticker!.id;
  const tiers = await db
    .insert(rewardTiers)
    .values([
      { classId: f.classA.id, minStars: 10, giftId: sticker!.id },
      { classId: f.classA.id, minStars: 30, giftId: kit!.id },
    ])
    .returning();
  [tier10, tier30] = [tiers[0]!.id, tiers[1]!.id];
  const [session] = await db.insert(sessions).values({ classId: f.classA.id, date: "2026-01-06", startTime: "08:00", endTime: "09:30" }).returning();
  await db.insert(starLogs).values({ sessionId: session!.id, studentId: a1(), stars: 25 });
});

describe("đổi quà bằng sao", () => {
  it("trừ sao còn lại theo mốc quà, trừ tồn kho; tổng tích lũy giữ nguyên", async () => {
    const teacher = withRewards(f.actorA);
    const before = await redemptions.getRedemptionInfo(teacher, a1());
    expect(before).toMatchObject({ total: 25, spent: 0, balance: 25, canRedeem: true });
    // Mốc 30 sao chưa đủ sao (và kho hết quà) nên không nằm trong danh sách đổi được.
    expect(before.options.map((o) => o.minStars)).toEqual([10]);

    await expect(redemptions.redeemGift(teacher, { studentId: a1(), tierId: tier10 })).resolves.toMatchObject({ balance: 15, stars: 10 });
    await redemptions.redeemGift(teacher, { studentId: a1(), tierId: tier10 });
    expect(await redemptions.getRedemptionInfo(teacher, a1())).toMatchObject({ total: 25, spent: 20, balance: 5 });
    expect((await db.select().from(gifts).where(eq(gifts.id, giftId)))[0]!.stock).toBe(0);
    // Tổng tích lũy không giảm sau khi đổi quà.
    expect((await stars.starTotalsOf(db, [a1()])).get(a1())).toBe(25);

    // Không đủ sao còn lại.
    await db.update(gifts).set({ stock: 5 }).where(eq(gifts.id, giftId));
    await expect(redemptions.redeemGift(teacher, { studentId: a1(), tierId: tier10 })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("chặn khi hết kho, không có quyền, ngoài phạm vi lớp hoặc mốc không áp dụng", async () => {
    await expect(redemptions.redeemGift(f.admin, { studentId: a1(), tierId: tier30 })).rejects.toMatchObject({ code: "CONFLICT" });
    // Vai trò Giáo viên mặc định không có quyền Sửa ở Quà & Tổng kết.
    await expect(redemptions.redeemGift(f.actorA, { studentId: a1(), tierId: tier10 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await redemptions.getRedemptionInfo(f.actorA, a1())).options).toEqual([]);
    // GV lớp khác dù có quyền đổi quà cũng không đổi cho học viên ngoài lớp mình.
    await expect(redemptions.redeemGift(withRewards(f.actorB), { studentId: a1(), tierId: tier10 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Mốc quà của lớp B không áp dụng cho học viên lớp A.
    const [other] = await db.insert(rewardTiers).values({ classId: f.classB.id, minStars: 5, giftId }).returning();
    await expect(redemptions.redeemGift(f.admin, { studentId: a1(), tierId: other!.id })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.select().from(giftRedemptions)).toEqual([]);
  });

  it("chỉ Admin hủy lần đổi quà: trả lại sao và tồn kho", async () => {
    const row = await redemptions.redeemGift(f.admin, { studentId: a1(), tierId: tier10 });
    await expect(redemptions.cancelRedemption(withRewards(f.actorA), row.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await redemptions.cancelRedemption(f.admin, row.id);
    expect(await redemptions.getRedemptionInfo(f.admin, a1())).toMatchObject({ spent: 0, balance: 25, history: [] });
    expect((await db.select().from(gifts).where(eq(gifts.id, giftId)))[0]!.stock).toBe(2);
  });
});
