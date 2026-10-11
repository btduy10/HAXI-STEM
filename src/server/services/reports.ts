import { and, count, desc, eq, gte, ilike, inArray, lte } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/db";
import { appSettings, auditLogs, user } from "@/db/schema";
import { WEEKDAY_LABELS, isoWeekday } from "@/lib/dates";
import { formatDate, formatDateTime, formatTime } from "@/lib/format";
import type { settingsInput } from "@/lib/validation/rewards";
import { audit } from "../audit";
import { AppError } from "../errors";
import type { ExportDoc } from "../export";
import { type Actor, assertAdmin } from "../guard";
import { ADMIN_LABEL, type PermissionConfig, normalizePermissions } from "@/lib/permissions";
import { PERMISSIONS_KEY, SETTING_DEFAULTS, type SettingKey, getPermissionConfig, getSettings } from "../settings";
import { type SessionFilters, listSessions } from "./sessions";
import { getClassSummary } from "./summaries";

// Dựng nội dung báo cáo để xuất. Quyền xem do các service nguồn kiểm tra.

const SESSION_STATUS = { planned: "Chưa điểm danh", done: "Đã dạy", cancelled: "Đã hủy" } as const;

export async function timetableDoc(actor: Actor, filters: SessionFilters): Promise<ExportDoc> {
  const sessions = await listSessions(actor, filters);
  return {
    filename: `thoi-khoa-bieu-${filters.from}-${filters.to}`,
    title: "Thời khóa biểu",
    subtitle: `Từ ${formatDate(filters.from)} đến ${formatDate(filters.to)}`,
    sections: [
      {
        title: "Buổi học",
        columns: [
          { header: "Ngày", width: 12 },
          { header: "Thứ", width: 10 },
          { header: "Giờ", width: 13 },
          { header: "Lớp", width: 26 },
          { header: "Phòng", width: 14 },
          { header: "Giáo viên", width: 22 },
          { header: "GV dạy thay", width: 22 },
          { header: "Trợ giảng", width: 22 },
          { header: "Loại", width: 9 },
          { header: "Trạng thái", width: 15 },
        ],
        rows: sessions.map((s) => [
          formatDate(s.date),
          WEEKDAY_LABELS[isoWeekday(s.date)] ?? "",
          `${formatTime(s.startTime)}–${formatTime(s.endTime)}`,
          `${s.classCode} – ${s.className}`,
          s.roomName ?? "",
          s.teacherName ?? "",
          s.substituteName ?? "",
          s.assistantName ?? "",
          s.kind === "makeup" ? "Học bù" : "Thường",
          SESSION_STATUS[s.status],
        ]),
      },
    ],
  };
}

export async function summaryDoc(actor: Actor, classId: string): Promise<ExportDoc> {
  const summary = await getClassSummary(actor, classId);
  const status = (row: (typeof summary.rows)[number]) =>
    !row.handover ? (row.proposedGift ? "Chờ duyệt" : "") : row.handover.status === "given" ? "Đã trao" : "Đã duyệt, chưa trao";
  return {
    filename: `tong-ket-${summary.class.code}`,
    title: `Tổng kết lớp ${summary.class.code} – ${summary.class.name}`,
    subtitle: summary.finalizedAt ? `Chốt lúc ${formatDateTime(summary.finalizedAt)}` : "Chưa chốt tổng kết",
    sections: [
      {
        title: "Xếp hạng và quà tặng",
        columns: [
          { header: "Hạng", width: 7, align: "right" },
          { header: "Mã HV", width: 10 },
          { header: "Họ tên", width: 26 },
          { header: "Tổng sao khóa", width: 13, align: "right" },
          { header: "Chuyên cần (%)", width: 14, align: "right" },
          { header: "Quà", width: 24 },
          { header: "Trạng thái", width: 18 },
          { header: "Ngày trao", width: 16 },
          { header: "Người trao", width: 18 },
          { header: "Ký nhận", width: 16 },
        ],
        rows: summary.rows.map((r) => [
          r.rank,
          r.code,
          r.fullName,
          r.totalStars,
          r.attendanceRate,
          r.handover?.giftName ?? r.proposedGift?.name ?? "",
          status(r),
          r.handover?.givenAt ? formatDateTime(r.handover.givenAt) : "",
          r.handover?.givenByName ?? "",
          "",
        ]),
      },
      {
        title: "Số lượng quà cần chuẩn bị",
        columns: [
          { header: "Quà", width: 26 },
          { header: "Đủ điều kiện", width: 13, align: "right" },
          { header: "Đã duyệt", width: 10, align: "right" },
          { header: "Đã trao", width: 10, align: "right" },
          { header: "Tồn kho", width: 10, align: "right" },
          { header: "Còn thiếu", width: 10, align: "right" },
        ],
        rows: summary.giftNeeds.map((g) => [g.name, g.eligible, g.approved, g.given, g.stock, g.missing]),
      },
    ],
  };
}

// ---------- Nhật ký ----------

export const AUDIT_PAGE_SIZE = 50;
export type AuditFilters = { action?: string; tableName?: string; from?: string; to?: string; page?: number };

export async function listAuditLogs(actor: Actor, filters: AuditFilters) {
  assertAdmin(actor);
  const conditions = [];
  if (filters.action) conditions.push(ilike(auditLogs.action, `%${filters.action.replace(/[%_\\]/g, "\\$&")}%`));
  if (filters.tableName) conditions.push(eq(auditLogs.tableName, filters.tableName));
  // Lọc theo ngày giờ Việt Nam (UTC+7).
  if (filters.from) conditions.push(gte(auditLogs.createdAt, new Date(`${filters.from}T00:00:00+07:00`)));
  if (filters.to) conditions.push(lte(auditLogs.createdAt, new Date(`${filters.to}T23:59:59.999+07:00`)));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const page = Math.max(1, filters.page ?? 1);

  const [rows, [total]] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        createdAt: auditLogs.createdAt,
        action: auditLogs.action,
        tableName: auditLogs.tableName,
        recordId: auditLogs.recordId,
        oldValue: auditLogs.oldValue,
        newValue: auditLogs.newValue,
        username: user.username,
      })
      .from(auditLogs)
      .leftJoin(user, eq(user.id, auditLogs.userId))
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(AUDIT_PAGE_SIZE)
      .offset((page - 1) * AUDIT_PAGE_SIZE),
    db.select({ n: count() }).from(auditLogs).where(where),
  ]);
  return { rows, total: total?.n ?? 0, page, pages: Math.max(1, Math.ceil((total?.n ?? 0) / AUDIT_PAGE_SIZE)) };
}

export async function listAuditTables(actor: Actor) {
  assertAdmin(actor);
  const rows = await db.selectDistinct({ tableName: auditLogs.tableName }).from(auditLogs).orderBy(auditLogs.tableName);
  return rows.map((r) => r.tableName);
}

// ---------- Cấu hình ----------

export async function readSettings(actor: Actor) {
  assertAdmin(actor);
  return getSettings();
}

export async function updateSettings(actor: Actor, data: z.output<typeof settingsInput>) {
  assertAdmin(actor);
  await db.transaction(async (tx) => {
    const before = await getSettings(tx);
    for (const key of Object.keys(SETTING_DEFAULTS) as SettingKey[]) {
      await tx
        .insert(appSettings)
        .values({ key, value: data[key] })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: data[key], updatedAt: new Date() } });
    }
    await audit(tx, { userId: actor.userId, action: "settings_updated", tableName: "app_settings", oldValue: before, newValue: data });
  });
  return data;
}

// ---------- Phân quyền theo vai trò ----------

export async function readPermissions(actor: Actor) {
  assertAdmin(actor);
  return getPermissionConfig();
}

/**
 * Admin lưu danh sách vai trò và bảng phân quyền (gồm cả vai trò mới tạo, đổi tên, xóa).
 * Có hiệu lực ngay ở yêu cầu kế tiếp của mọi người dùng. Không xóa được vai trò đang gán cho tài khoản.
 */
export async function updatePermissions(actor: Actor, data: PermissionConfig) {
  assertAdmin(actor);
  const value = normalizePermissions(data);
  const labels = Object.values(value).map((role) => role.label.toLowerCase());
  if (new Set([...labels, ADMIN_LABEL.toLowerCase()]).size !== labels.length + 1) {
    throw new AppError("VALIDATION", "Tên vai trò bị trùng. Mỗi vai trò cần một tên riêng.");
  }
  await db.transaction(async (tx) => {
    const before = await getPermissionConfig(tx);
    const removed = Object.keys(before).filter((key) => !Object.hasOwn(value, key));
    if (removed.length > 0) {
      const [usedByAccount] = await tx.select({ role: user.role }).from(user).where(inArray(user.role, removed)).limit(1);
      const used = usedByAccount?.role;
      if (used) {
        throw new AppError("CONFLICT", `Vai trò "${before[used]!.label}" đang được gán cho tài khoản nên không xóa được. Hãy đổi vai trò của tài khoản đó trước.`);
      }
    }
    await tx
      .insert(appSettings)
      .values({ key: PERMISSIONS_KEY, value })
      .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
    await audit(tx, { userId: actor.userId, action: "permissions_updated", tableName: "app_settings", oldValue: before, newValue: value });
  });
  return value;
}