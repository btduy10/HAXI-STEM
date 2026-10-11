import { z } from "zod";

// Phân quyền theo vai trò, do Admin tick trong trang Cấu hình. Dùng chung cho máy chủ và giao diện.
// Admin luôn có toàn quyền. Tài khoản, Nhật ký, Cấu hình luôn chỉ dành cho Admin. Xóa dữ liệu cũng chỉ Admin,
// trừ menu có thao tác "delete" (hiện chỉ Syllabus) thì theo ô tick Xóa của vai trò.

// Vai trò: "admin" (Quản trị, cố định) và các vai trò được phân quyền. Hai vai trò có sẵn không xóa được;
// Admin tạo thêm vai trò khác trong Cấu hình → Phân quyền. Khóa vai trò lưu ở tài khoản và hồ sơ giáo viên.
export const BUILTIN_ROLES = ["teacher", "duty_teacher"] as const;
export type UserRole = string;
export const ADMIN_LABEL = "Quản trị";
export const ROLE_KEY = /^[a-z][a-z0-9_]{1,39}$/;
export const MAX_ROLES = 20;
export const ROLE_LABEL_MAX = 40;
export const PERMISSION_ACTIONS = ["view", "add", "edit", "delete"] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];
export const ACTION_LABELS: Record<PermissionAction, string> = { view: "Xem", add: "Thêm", edit: "Sửa", delete: "Xóa" };

/** Các menu có thể mở cho Giáo viên / Giáo viên trực, theo đúng thứ tự trên thanh menu của Admin. */
export const PERMISSION_MENUS = [
  { key: "courses", label: "Khóa học", href: "/admin/courses", actions: ["view", "add", "edit"], hint: "" },
  { key: "rooms", label: "Phòng & Ca học", href: "/admin/rooms-slots", actions: ["view", "add", "edit"], hint: "Gồm cả ngày nghỉ." },
  { key: "teachers", label: "Giáo viên", href: "/admin/teachers", actions: ["view", "add", "edit"], hint: "" },
  { key: "classes", label: "Lớp học", href: "/admin/classes", actions: ["view", "add", "edit"], hint: "Sửa gồm cả phân công giáo viên, lịch mẫu và sinh buổi học." },
  { key: "syllabus", label: "Syllabus", href: "/admin/syllabus", actions: ["view", "add", "edit", "delete"], hint: "Chương trình dạy theo Lớp + Khóa học + Buổi. Thêm gồm cả nhập từ Excel (bài đã có chỉ được cập nhật khi có Sửa)." },
  { key: "enrollments", label: "Ghi danh", href: "/admin/enrollments", actions: ["view", "add", "edit"], hint: "Thêm = nhập học viên mới, ghi danh, xếp lớp, xếp học bù; Sửa = cho rời lớp, hủy xếp bù." },
  { key: "students", label: "QL Học viên", href: "/admin/students", actions: ["view", "edit"], hint: "Xem danh sách, hồ sơ, lịch sử học; Sửa = sửa thông tin học viên. Học viên mới nhập ở Ghi danh. Ngày sinh, phụ huynh, điện thoại, ghi chú chỉ hiện khi tick “Thông tin cá nhân học viên”." },
  { key: "timetable", label: "Thời khóa biểu", href: "/admin/timetable", actions: ["view", "add", "edit"], hint: "Thêm = xếp buổi, buổi bù; Sửa = sửa, dời, hủy, khôi phục, dạy thay." },
  { key: "attendance", label: "Điểm danh", href: "/admin/attendance", actions: ["view", "add", "edit"], hint: "Thêm = điểm danh buổi chưa điểm danh; Sửa = sửa điểm danh đã lưu." },
  { key: "stars", label: "Sao", href: "/admin/stars", actions: ["view", "add", "edit"], hint: "Thêm = ghi sao; Sửa = hoàn tác sao. Tiêu chí sao chỉ Admin chỉnh." },
  { key: "rewards", label: "Quà & Tổng kết", href: "/admin/rewards", actions: ["view", "add", "edit"], hint: "Thêm = quà, mốc quà; Sửa = sửa quà, đóng lớp, duyệt và trao quà, đổi quà bằng sao cho học viên." },
  { key: "timesheet", label: "Chấm công", href: "/admin/timesheet", actions: ["view", "add", "edit"], hint: "Xem gồm cả mức lương, thành tiền. Thêm = chấm công bổ sung; Sửa = sửa ngày, ca, lớp của dòng công và đặt mức lương (đặt mức lương cần phạm vi “Tất cả lớp”). Xóa chỉ Admin. Phạm vi “lớp của mình” chỉ thấy và thao tác công của chính mình." },
  { key: "tuition", label: "Học phí", href: "/admin/tuition", actions: ["view", "add", "edit"], hint: "Thêm = lập phiếu thu; Sửa = đặt học phí lớp, giảm học phí. Hủy phiếu thu chỉ Admin." },
  { key: "reports", label: "Báo cáo", href: "/admin/reports", actions: ["view", "add", "edit"], hint: "Doanh thu, chi, lãi của cả trung tâm; cần phạm vi “Tất cả lớp”. Xem gồm cả xuất tệp. Thêm/Sửa = nhập, sửa mua sắm. Xóa chỉ Admin." },
] as const satisfies readonly { key: string; label: string; href: string; actions: readonly PermissionAction[]; hint: string }[];

export type Menu = (typeof PERMISSION_MENUS)[number]["key"];
export type ClassScope = "own" | "all";
/** `delete` chỉ có ở menu hỗ trợ thao tác Xóa; thiếu = không được xóa. */
export type MenuPermission = { view: boolean; add: boolean; edit: boolean; delete?: boolean };
const supports = (menu: { actions: readonly PermissionAction[] }, action: PermissionAction) => menu.actions.includes(action);
export type RolePermissions = {
  scope: ClassScope;
  menus: Record<Menu, MenuPermission>;
  /** Được xem và sửa thông tin cá nhân của học viên (ngày sinh, giới tính, phụ huynh, điện thoại, ghi chú). Thiếu = không. */
  studentPrivate?: boolean;
};
/** Một vai trò trong Cấu hình: tên hiển thị + quyền. */
export type RoleConfig = RolePermissions & { label: string };
export type PermissionConfig = Record<string, RoleConfig>;

export const SCOPE_LABELS: Record<ClassScope, string> = { own: "Chỉ lớp của mình", all: "Tất cả lớp" };

const NONE: MenuPermission = { view: false, add: false, edit: false };
const FULL: MenuPermission = { view: true, add: true, edit: true };
const menusWith = (granted: Partial<Record<Menu, MenuPermission>>) =>
  Object.fromEntries(
    PERMISSION_MENUS.map((m) => {
      const { delete: remove, ...item } = granted[m.key] ?? NONE;
      return [m.key, supports(m, "delete") ? { ...item, delete: remove === true } : item];
    }),
  ) as Record<Menu, MenuPermission>;

/** Không có quyền gì: dùng cho vai trò lạ hoặc đã bị xóa, và làm điểm bắt đầu cho vai trò mới tạo. */
export const NO_PERMISSIONS: RolePermissions = { scope: "own", menus: menusWith({}), studentPrivate: false };

const VIEW: MenuPermission = { view: true, add: false, edit: false };
const VIEW_EDIT: MenuPermission = { view: true, add: false, edit: true };
const FULL_WITH_DELETE: MenuPermission = { ...FULL, delete: true };

/**
 * Mặc định: Giáo viên điểm danh, chấm sao lớp mình, xem học viên lớp mình (không có thông tin cá nhân)
 * và tự soạn Syllabus của lớp mình (xem, thêm, sửa, xóa);
 * Giáo viên trực thấy mọi lớp, hỗ trợ điểm danh, xem và sửa thông tin học viên kể cả thông tin cá nhân.
 */
export const DEFAULT_PERMISSIONS: PermissionConfig = {
  teacher: { label: "Giáo viên", scope: "own", menus: menusWith({ attendance: FULL, stars: FULL, students: VIEW, syllabus: FULL_WITH_DELETE }), studentPrivate: false },
  duty_teacher: { label: "Giáo viên trực", scope: "all", menus: menusWith({ attendance: FULL, students: VIEW_EDIT }), studentPrivate: true },
};

export const isBuiltinRole = (role: string) => (BUILTIN_ROLES as readonly string[]).includes(role);
export const roleLabel = (config: PermissionConfig, role: string) =>
  role === "admin" ? ADMIN_LABEL : Object.hasOwn(config, role) ? config[role]!.label : "Vai trò đã xóa";
/** Lựa chọn vai trò cho ô chọn (không gồm Quản trị). */
export const roleOptions = (config: PermissionConfig) => Object.entries(config).map(([value, role]) => ({ value, label: role.label }));

const menuPermission = z.object({ view: z.boolean(), add: z.boolean(), edit: z.boolean(), delete: z.boolean().optional() });
const roleConfig = z.object({
  label: z.string().trim().min(1, "Bắt buộc nhập tên vai trò").max(ROLE_LABEL_MAX, `Tối đa ${ROLE_LABEL_MAX} ký tự`),
  scope: z.enum(["own", "all"]),
  studentPrivate: z.boolean().optional(),
  menus: z.object(Object.fromEntries(PERMISSION_MENUS.map((m) => [m.key, menuPermission])) as Record<Menu, typeof menuPermission>),
});
export const permissionConfigInput = z
  .record(z.string().regex(ROLE_KEY), roleConfig)
  .refine((v) => Object.keys(v).length <= MAX_ROLES, `Tối đa ${MAX_ROLES} vai trò`)
  .refine((v) => !("admin" in v), "Không sửa được vai trò Quản trị");

/**
 * Chuẩn hóa cấu hình đọc từ CSDL hoặc gửi từ form: hai vai trò có sẵn luôn tồn tại (thiếu/sai thì lấy mặc định,
 * tên cố định); vai trò tự tạo phải có khóa và tên hợp lệ; không có Xem thì không có Thêm/Sửa/Xóa;
 * bỏ các thao tác menu không hỗ trợ. Ô Xóa chỉ có ở menu hỗ trợ; cấu hình lưu trước khi có ô này coi như chưa tick.
 */
export function normalizePermissions(value: unknown): PermissionConfig {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const custom = Object.keys(source).filter((key) => key !== "admin" && !isBuiltinRole(key) && ROLE_KEY.test(key));
  const out: PermissionConfig = {};
  for (const role of [...BUILTIN_ROLES, ...custom].slice(0, MAX_ROLES)) {
    const fallback = DEFAULT_PERMISSIONS[role] ?? NO_PERMISSIONS;
    const raw = (source[role] && typeof source[role] === "object" ? source[role] : {}) as {
      label?: unknown;
      scope?: unknown;
      studentPrivate?: unknown;
      menus?: Record<string, unknown>;
    };
    const label = isBuiltinRole(role)
      ? DEFAULT_PERMISSIONS[role]!.label
      : typeof raw.label === "string"
        ? raw.label.trim().slice(0, ROLE_LABEL_MAX)
        : "";
    if (!label) continue;
    const rawMenus = raw.menus && typeof raw.menus === "object" ? raw.menus : {};
    const menus = {} as Record<Menu, MenuPermission>;
    for (const menu of PERMISSION_MENUS) {
      const parsed = menuPermission.safeParse(rawMenus[menu.key]);
      const item = parsed.success ? parsed.data : fallback.menus[menu.key];
      const view = item.view && supports(menu, "view");
      menus[menu.key] = {
        view,
        add: view && item.add && supports(menu, "add"),
        edit: view && item.edit && supports(menu, "edit"),
        ...(supports(menu, "delete") ? { delete: view && item.delete === true } : {}),
      };
    }
    out[role] = {
      label,
      scope: raw.scope === "own" || raw.scope === "all" ? raw.scope : fallback.scope,
      menus,
      // Cấu hình lưu trước khi có ô tick này: lấy theo mặc định của vai trò.
      studentPrivate: typeof raw.studentPrivate === "boolean" ? raw.studentPrivate : fallback.studentPrivate === true,
    };
  }
  return out;
}