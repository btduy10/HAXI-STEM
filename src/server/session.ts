import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { type Menu, NO_PERMISSIONS, type PermissionAction, type UserRole, roleLabel } from "@/lib/permissions";
import { auth } from "./auth";
import { AppError } from "./errors";
import { type Actor, can, unauthenticated } from "./guard";
import { getPermissionConfig } from "./settings";

export type SessionUser = {
  id: string;
  name: string;
  username: string;
  role: UserRole;
  teacherId: string | null;
  mustChangePassword: boolean;
  twoFactorEnabled: boolean;
};

/** Phiên hiện tại, đọc lại từ CSDL mỗi request (không cache cookie) để khóa/đổi quyền có hiệu lực ngay. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const result = await auth.api.getSession({ headers: await headers() });
  if (!result) return null;
  const u = result.user;
  return {
    id: u.id,
    name: u.name,
    username: u.username ?? "",
    role: typeof u.role === "string" && u.role ? u.role : "teacher",
    teacherId: u.teacherId ?? null,
    mustChangePassword: u.mustChangePassword,
    twoFactorEnabled: Boolean(u.twoFactorEnabled),
  };
});

// Bảng phân quyền đọc lại mỗi request nên Admin đổi là có hiệu lực ngay.
const loadPermissions = cache(() => getPermissionConfig());

async function actorOf(user: SessionUser): Promise<Actor> {
  const base = { userId: user.id, role: user.role, teacherId: user.teacherId };
  // Vai trò không còn trong Cấu hình (đã bị xóa) thì không có quyền gì.
  if (user.role === "admin") return base;
  const config = await loadPermissions();
  return { ...base, perms: Object.hasOwn(config, user.role) ? config[user.role]! : NO_PERMISSIONS };
}

/** Tên hiển thị của vai trò người dùng theo Cấu hình (vd. "Quản trị", "Giáo viên"). */
export async function roleLabelOf(user: SessionUser): Promise<string> {
  return user.role === "admin" ? roleLabel({}, "admin") : roleLabel(await loadPermissions(), user.role);
}

/** Bước bắt buộc còn thiếu trước khi được dùng hệ thống. */
/**
 * 2FA bắt buộc với Admin (mặc định). Đặt ADMIN_2FA_REQUIRED=false để bỏ qua khi chạy thử;
 * KHÔNG nên tắt khi hệ thống chứa dữ liệu thật của học viên.
 */
const needsTwoFactorSetup = (user: SessionUser) =>
  process.env.ADMIN_2FA_REQUIRED !== "false" && user.role === "admin" && !user.twoFactorEnabled;

export function pendingStep(user: SessionUser): "/change-password" | "/two-factor/setup" | null {
  if (user.mustChangePassword) return "/change-password";
  if (needsTwoFactorSetup(user)) return "/two-factor/setup";
  return null;
}

export const homeOf = (user: SessionUser) => (user.role === "admin" ? "/admin/dashboard" : "/teacher/dashboard");

/** Dùng trong Server Action / Route Handler: ném lỗi thay vì chuyển hướng. */
export async function requireActor(): Promise<Actor> {
  const user = await getSessionUser();
  if (!user) throw unauthenticated();
  if (user.mustChangePassword) throw new AppError("FORBIDDEN", "Bạn cần đổi mật khẩu trước khi tiếp tục.");
  if (needsTwoFactorSetup(user)) {
    throw new AppError("FORBIDDEN", "Quản trị viên cần bật xác thực hai lớp trước khi tiếp tục.");
  }
  return actorOf(user);
}

/**
 * Dùng trong trang/layout: chuyển hướng khi chưa đủ điều kiện.
 * "admin" = chỉ Quản trị; "teacher" = Giáo viên hoặc Giáo viên trực (khu vực giảng dạy).
 */
export async function requirePageUser(area?: "admin" | "teacher"): Promise<SessionUser & { actor: Actor }> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const step = pendingStep(user);
  if (step) redirect(step);
  if (area && (area === "admin") !== (user.role === "admin")) redirect(homeOf(user));
  return { ...user, actor: await actorOf(user) };
}

/**
 * Trang quản lý của một menu: Admin luôn vào được; vai trò khác phải được tick "Xem" ở menu đó,
 * nếu không thì về trang chủ của mình. `can` dùng để ẩn/hiện nút — máy chủ vẫn kiểm tra lại trong service.
 */
export async function requireMenu(menu: Menu) {
  const user = await requirePageUser();
  if (!can(user.actor, menu, "view")) redirect(homeOf(user));
  return { ...user, can: (action: PermissionAction, of: Menu = menu) => can(user.actor, of, action) };
}
