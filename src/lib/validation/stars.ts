import { z } from "zod";
import { id, intIn, optText, reqText } from "./common";

export const criteriaInput = z
  .object({
    name: reqText(100),
    stars: intIn(-20, 20),
    active: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .default(true)
      .transform((v) => v === true || v === "true"),
  })
  .refine((v) => v.stars !== 0, { path: ["stars"], message: "Số sao phải khác 0 (âm = trừ sao)" })
  .transform((v) => ({ ...v, type: v.stars > 0 ? ("reward" as const) : ("penalty" as const) }));

export const criteriaUpdate = z.object({ id, data: criteriaInput });

export const awardInput = z.object({
  sessionId: id,
  criteriaId: id,
  studentIds: z.array(id).min(1, "Chọn ít nhất một học viên").max(300),
  note: optText(200),
});

export const undoInput = z.object({ logId: id });
