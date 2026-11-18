import { and, eq, ne, or } from "drizzle-orm";
import { db, type DbOrTx } from "@/db";
import { classTeachers, classes, scheduleTemplates, sessions } from "@/db/schema";
import {
  DEFAULT_PERMISSIONS,
  NO_PERMISSIONS,
  type Menu,
  type PermissionAction,
  type RolePermissions,
  type UserRole,
} from "@/lib/permissions";
import { CLASS_CLOSED_MESSAGE, TIMETABLE_ONLY_MESSAGE } from "@/domain/session-write";
import { AppError, forbidden, notFound } from "./errors";

// Người thực hiện thao tác, luôn lấy từ phiên ở máy chủ (không nhận từ client).
export type Actor = {
  userId: string;
  role: UserRole;
  teacherId: string | null;
  /** Quyền của vai trò, nạp từ Cấu hình cùng lúc với phiên. Thiếu thì dùng mặc định của vai trò (vai trò lạ: không có quyền gì). */
  perms?: RolePermissions;
};

export const isAdmin = (actor: Actor) => actor.role === "admin";

export function assertAdmin(actor: Actor) {
  if (!isAdmin(actor)) throw forbidden();
}

const permsOf = (actor: Actor): RolePermissions | null =>
  isAdmin(actor) ? null : (actor.perms ?? (Object.hasOwn(DEFAULT_PERMISSIONS, actor.role) ? DEFAULT_PERMISSIONS[actor.role]! : NO_PERMISSIONS));

/** Vai trò có được làm thao tác này ở menu này không (theo bảng tick trong Cấu hình). Admin luôn được. */
export function can(actor: Actor, menu: Menu, action: PermissionAction): boolean {
  const perms = permsOf(actor);
  return perms === null || perms.menus[menu]?.[action] === true;
}

export function assertCan(actor: Actor, menu: Menu, action: PermissionAction) {
  if (!can(actor, menu, action)) throw forbidden();
}

/** Được thao tác ở ít nhất một trong các quyền nêu ra. */
export function assertCanAny(actor: Actor, ...grants: [Menu, PermissionAction][]) {
  if (!grants.some(([menu, action]) => can(actor, menu, action))) throw forbidden();
}

/** Dữ liệu tham chiếu (khóa học, phòng, ca, ngày nghỉ): chỉ cần là người dùng đã đăng nhập. */
export function assertSignedIn(actor: Actor) {
  if (!actor.userId) throw unauthenticated();
}

/**
 * Được xem và sửa thông tin cá nhân của học viên (ngày sinh, giới tính, phụ huynh, điện thoại, ghi chú):
 * Admin, hoặc vai trò được tick "Thông tin cá nhân học viên" trong Cấu hình. Tối thiểu hóa dữ liệu của trẻ em.
 */
export const seesStudentPrivate = (actor: Actor) => isAdmin(actor) || permsOf(actor)?.studentPrivate === true;

/** Admin, hoặc vai trò được cấu hình phạm vi "Tất cả lớp". */
export const seesAllClasses = (actor: Actor) => permsOf(actor)?.scope !== "own";

/**
 * Lớp của một giáo viên: được phân công ở Lớp học → Giáo viên, hoặc được xếp dạy bên Thời khóa biểu
 * (GV chính hoặc trợ giảng trong lịch mẫu của lớp, hoặc của một buổi chưa hủy). Dạy thay chỉ có quyền trên đúng buổi đó.
 */
function teacherClassIds(teacherId: string, tx: DbOrTx, classId?: string) {
  const only = <T extends { classId: typeof classTeachers.classId | typeof sessions.classId | typeof scheduleTemplates.classId }>(t: T) =>
    classId ? eq(t.classId, classId) : undefined;
  return tx
    .select({ classId: classTeachers.classId })
    .from(classTeachers)
    .where(and(eq(classTeachers.teacherId, teacherId), only(classTeachers)))
    .union(
      tx
        .select({ classId: scheduleTemplates.classId })
        .from(scheduleTemplates)
        .where(
          and(or(eq(scheduleTemplates.teacherId, teacherId), eq(scheduleTemplates.assistantTeacherId, teacherId)), only(scheduleTemplates)),
        ),
    )
    .union(
      tx
        .select({ classId: sessions.classId })
        .from(sessions)
        .where(
          and(
            or(eq(sessions.teacherId, teacherId), eq(sessions.assistantTeacherId, teacherId)),
            ne(sessions.status, "cancelled"),
            only(sessions),
          ),
        ),
    );
}

/** Danh sách lớp trong phạm vi của người dùng. null = không giới hạn (Admin hoặc phạm vi "Tất cả lớp"). */
export async function allowedClassIds(actor: Actor, tx: DbOrTx = db): Promise<string[] | null> {
  if (seesAllClasses(actor)) return null;
  if (!actor.teacherId) return [];
  const rows = await teacherClassIds(actor.teacherId, tx);
  return rows.map((r) => r.classId);
}

/**
 * Chống IDOR: GV chỉ truy cập lớp mình được phân công hoặc được xếp dạy.
 * Trả NOT_FOUND thay vì FORBIDDEN để không lộ sự tồn tại của lớp khác.
 */
export async function assertClassAccess(actor: Actor, classId: string, tx: DbOrTx = db) {
  if (seesAllClasses(actor)) return;
  if (!actor.teacherId) throw notFound("lớp học");
  const rows = await teacherClassIds(actor.teacherId, tx, classId);
  if (rows.length === 0) throw notFound("lớp học");
}

/** GV được vào buổi học nếu buổi thuộc lớp của mình, hoặc là GV dạy/dạy thay/trợ giảng của chính buổi đó. */
export async function assertSessionAccess(actor: Actor, sessionId: string, tx: DbOrTx = db) {
  if (seesAllClasses(actor)) return;
  if (!actor.teacherId) throw notFound("buổi học");
  const [row] = await tx
    .select({
      classId: sessions.classId,
      teacherId: sessions.teacherId,
      substituteTeacherId: sessions.substituteTeacherId,
      assistantTeacherId: sessions.assistantTeacherId,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) throw notFound("buổi học");
  if ([row.teacherId, row.substituteTeacherId, row.assistantTeacherId].includes(actor.teacherId)) return;
  if ((await teacherClassIds(actor.teacherId, tx, row.classId)).length === 0) throw notFound("buổi học");
}

export const unauthenticated = () => new AppError("UNAUTHENTICATED", "Vui lòng đăng nhập.");

export { TIMETABLE_ONLY_MESSAGE } from "@/domain/session-write";

/**
 * Lớp "chỉ hiển thị trên Thời khóa biểu" (vd. cho mượn phòng) không có học viên: không điểm danh, ghi sao,
 * ghi danh, học phí, tổng kết, chấm công, Syllabus. Ẩn trên giao diện là chưa đủ nên chặn cả ở máy chủ.
 */
export async function assertNotTimetableOnly(classId: string, tx: DbOrTx = db) {
  if (await isTimetableOnly(classId, tx)) throw new AppError("CONFLICT", TIMETABLE_ONLY_MESSAGE);
}

export async function isTimetableOnly(classId: string, tx: DbOrTx = db) {
  const [cls] = await tx.select({ timetableOnly: classes.timetableOnly }).from(classes).where(eq(classes.id, classId)).limit(1);
  return cls?.timetableOnly === true;
}

/** Lớp đã đóng thì số liệu đã chốt: không điểm danh hay ghi/hoàn tác sao cho các buổi của lớp nữa. */
export async function assertClassOpen(classId: string, tx: DbOrTx = db) {
  const [cls] = await tx.select({ status: classes.status }).from(classes).where(eq(classes.id, classId)).limit(1);
  if (cls?.status !== "open") throw new AppError("CONFLICT", CLASS_CLOSED_MESSAGE);
}