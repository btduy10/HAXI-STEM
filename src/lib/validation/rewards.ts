import { z } from "zod";
import { id, intIn, optText, reqText } from "./common";

export const giftInput = z.object({
  name: reqText(100),
  description: optText(300),
  stock: intIn(0, 100000),
});
export const giftUpdate = z.object({ id, data: giftInput });

/** Mốc quà đặt theo lớp. */
export const tierInput = z.object({
  classId: id,
  minStars: intIn(0, 100000),
  giftId: id,
});

export const classIdOnly = z.object({ classId: id });
export const approveInput = z.object({ classId: id, summaryIds: z.array(id).min(1, "Chọn ít nhất một học viên").max(500) });
export const redeemInput = z.object({ studentId: id, tierId: id });
export const handoverIdInput = z.object({ handoverId: id });

/** Thông tin trung tâm in ở đầu giấy báo học phí và phiếu thu. */
export const centerInfoInput = z.object({
  name: reqText(100),
  address: optText(200),
  phone: optText(50),
  bank: optText(300),
});

export const settingsInput = z.object({
  attendance_lock_days: intIn(0, 365),
  max_deduction_per_session: intIn(0, 50),
});
