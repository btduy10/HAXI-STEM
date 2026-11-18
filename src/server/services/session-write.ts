import { eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { classes, sessions } from "@/db/schema";
import { type SessionWork, type WriteBlock, sessionWriteBlock } from "@/domain/session-write";
import { todayIso } from "@/lib/format";
import { AppError, notFound } from "../errors";
import { type Actor, assertSessionAccess } from "../guard";
import { getSettings } from "../settings";

type SessionFields = Pick<typeof sessions.$inferSelect, "classId" | "date" | "status" | "attendanceUnlockedUntil">;

async function blockOf(tx: DbOrTx, session: SessionFields, work: SessionWork, now: Date): Promise<WriteBlock | null> {
  const [cls] = await tx.select({ status: classes.status, timetableOnly: classes.timetableOnly }).from(classes).where(eq(classes.id, session.classId)).limit(1);
  const settings = await getSettings(tx);
  return sessionWriteBlock(
    { ...session, classStatus: cls?.status ?? "closed", timetableOnly: cls?.timetableOnly ?? false },
    work,
    { today: todayIso(now), now, lockDays: settings.attendance_lock_days },
  );
}

/**
 * Lý do buổi học chưa điểm danh / ghi sao được, để trang báo trước; null khi được ghi. Không kiểm tra quyền:
 * gọi sau khi service đã kiểm tra quyền vào buổi.
 */
export function sessionWriteState(session: SessionFields, work: SessionWork, now: Date = new Date()): Promise<WriteBlock | null> {
  return blockOf(db, session, work, now);
}

/**
 * Mở buổi học để ghi trong một transaction: kiểm tra quyền vào buổi (chống IDOR), khóa dòng của buổi để hai lần lưu
 * đồng thời không chen nhau, rồi chặn bằng đúng lý do của `sessionWriteBlock` (lỗi CONFLICT). Trả về dòng của buổi.
 */
export async function openSessionForWrite(actor: Actor, tx: DbOrTx, sessionId: string, work: SessionWork, now: Date) {
  await assertSessionAccess(actor, sessionId, tx);
  const [session] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for("update").limit(1);
  if (!session) throw notFound("buổi học");
  const block = await blockOf(tx, session, work, now);
  if (block) throw new AppError("CONFLICT", block.message);
  return session;
}
