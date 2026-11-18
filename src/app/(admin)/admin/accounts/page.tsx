import type { Metadata } from "next";
import { ConfirmButton, FormDialogButton } from "@/components/action-buttons";
import { AutoSubmitSelect } from "@/components/auto-submit-select";
import type { Field } from "@/components/form-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import { ADMIN_LABEL, roleLabel, roleOptions } from "@/lib/permissions";
import { paramText } from "@/lib/search-params";
import {
  createAccountAction,
  deleteAccountAction,
  lockAccountAction,
  resetPasswordAction,
  resetTwoFactorAction,
  sendAccountCredentialsAction,
  updateAccountAction,
} from "@/server/actions/admin";
import { listAccounts } from "@/server/services/accounts";
import { listTeachers } from "@/server/services/catalog";
import { readPermissions } from "@/server/services/reports";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Tài khoản" };

const ROLE_HINT = "Quyền của tài khoản theo vai trò này; tick quyền cho từng vai trò ở Cấu hình → Phân quyền.";
const PASSWORD_HINT = "Mật khẩu tạm, tối thiểu 8 ký tự gồm chữ và số. Người dùng phải đổi ở lần đăng nhập đầu.";

export default async function AccountsPage({ searchParams }: PageProps<"/admin/accounts">) {
  const user = await requirePageUser("admin");
  const [all, teachers, roles, params] = await Promise.all([
    listAccounts(user.actor),
    listTeachers(user.actor),
    readPermissions(user.actor),
    searchParams,
  ]);
  const now = new Date();
  const label = (role: string) => roleLabel(roles, role);
  const roleChoices = [{ value: "admin", label: ADMIN_LABEL }, ...roleOptions(roles)];

  // Lọc theo vai trò và từ khóa; sắp xếp: Quản trị trước, rồi theo tên vai trò, rồi tên đăng nhập.
  const q = paramText(params.q).trim().toLowerCase();
  const roleFilter = roleChoices.some((r) => r.value === paramText(params.role)) ? paramText(params.role) : "";
  const accounts = all
    .filter((a) => (!roleFilter || a.role === roleFilter) && (!q || `${a.username} ${a.name} ${a.teacherName ?? ""}`.toLowerCase().includes(q)))
    .sort(
      (a, b) =>
        Number(b.role === "admin") - Number(a.role === "admin") ||
        label(a.role).localeCompare(label(b.role), "vi") ||
        a.username.localeCompare(b.username),
    );

  const linked = new Set(all.map((a) => a.teacherId).filter(Boolean));
  const teacherOptions = (keepId: string | null) =>
    teachers
      .filter((t) => t.id === keepId || !linked.has(t.id))
      .map((t) => ({ value: t.id, label: `${t.code} – ${t.fullName}` }));
  const accountFields = (keepId: string | null): Field[] => [
    { name: "username", label: "Tên đăng nhập", required: true },
    { name: "name", label: "Tên hiển thị", required: true },
    { name: "role", label: "Vai trò", type: "select", required: true, options: roleChoices, hint: ROLE_HINT },
    { name: "teacherId", label: "Giáo viên gắn kèm", type: "select", options: teacherOptions(keepId) },
  ];

  type Account = (typeof accounts)[number];
  const isLocked = (a: Account) => Boolean(a.lockedUntil && a.lockedUntil > now);

  const badges = (a: Account) => (
    <>
      {isLocked(a) && <Badge variant="destructive">Đang khóa</Badge>}
      {a.mustChangePassword && <Badge variant="outline">Chưa đổi mật khẩu</Badge>}
      {a.twoFactorEnabled && <Badge variant="outline">2FA</Badge>}
    </>
  );

  const actions = (a: Account) => {
    const locked = isLocked(a);
    const isSelf = a.id === user.id;
    return (
      <>
        <FormDialogButton
          label="Sửa"
          variant="outline"
          className="h-9"
          title={`Sửa tài khoản ${a.username}`}
          description="Đổi tên đăng nhập, vai trò hoặc giáo viên gắn kèm sẽ đăng xuất tài khoản này khỏi mọi thiết bị."
          fields={accountFields(a.teacherId)}
          initial={{ username: a.username, name: a.name, role: a.role, teacherId: a.teacherId ?? "" }}
          fixed={{ id: a.id }}
          action={updateAccountAction}
          successMessage="Đã cập nhật tài khoản."
        />
        <FormDialogButton
          label="Đặt lại mật khẩu"
          variant="outline"
          className="h-9"
          title={`Đặt lại mật khẩu cho ${a.username}`}
          description={
            isSelf ? "Đặt mật khẩu mới cho chính bạn." : "Tài khoản sẽ bị đăng xuất khỏi mọi thiết bị và được mở khóa nếu đang bị khóa."
          }
          fields={[
            { name: "password", label: "Mật khẩu mới", type: "password", required: true, hint: "Tối thiểu 8 ký tự, gồm chữ và số." },
            {
              name: "mustChange",
              label: "Sau khi đặt lại",
              type: "select",
              required: true,
              options: [
                { value: "true", label: "Bắt đổi mật khẩu ở lần đăng nhập sau" },
                { value: "false", label: "Dùng luôn mật khẩu này" },
              ],
            },
          ]}
          initial={{ mustChange: isSelf ? "false" : "true" }}
          fixed={{ id: a.id }}
          action={resetPasswordAction}
          successMessage="Đã đặt lại mật khẩu."
        />
        {/* Gửi tên đăng nhập, mật khẩu tạm và hướng dẫn tới email của giáo viên gắn kèm (menu Giáo viên). */}
        {!isSelf && a.teacherId && (
          <FormDialogButton
            label="Gửi tài khoản"
            variant="outline"
            className="h-9"
            title={`Gửi tài khoản cho ${a.username}`}
            description={
              a.teacherEmail
                ? `Thư gửi tới ${a.teacherEmail} gồm tên đăng nhập, mật khẩu tạm dưới đây và hướng dẫn đăng nhập. Mật khẩu cũ hết hiệu lực, tài khoản bị đăng xuất khỏi mọi thiết bị và phải đổi mật khẩu ở lần đăng nhập đầu.`
                : `Giáo viên ${a.teacherName ?? ""} chưa có email. Nhập email ở menu Giáo viên trước khi gửi.`
            }
            fields={[{ name: "password", label: "Mật khẩu tạm", type: "password", required: true, hint: PASSWORD_HINT }]}
            fixed={{ id: a.id }}
            action={sendAccountCredentialsAction}
            submitLabel="Gửi"
            successMessage="Đã gửi tài khoản qua email."
          />
        )}
        {/* Admin khóa/mở khóa bất kỳ tài khoản nào khác; không tự khóa chính mình để khỏi mất quyền quản trị. */}
        {!isSelf && (
          <ConfirmButton
            label={locked ? "Mở khóa" : "Khóa"}
            className="h-9"
            confirmText={
              locked
                ? `Mở khóa tài khoản ${a.username}?`
                : `Khóa tài khoản ${a.username}? Tài khoản sẽ bị đăng xuất và không đăng nhập được cho tới khi bạn mở khóa.`
            }
            action={lockAccountAction}
            input={{ id: a.id, locked: !locked }}
            successMessage={locked ? "Đã mở khóa tài khoản." : "Đã khóa tài khoản."}
          />
        )}
        {!isSelf && a.twoFactorEnabled && (
          <ConfirmButton
            label="Đặt lại 2FA"
            className="h-9"
            confirmText={`Xóa thiết lập xác thực hai lớp của ${a.username}?`}
            action={resetTwoFactorAction}
            input={{ id: a.id }}
          />
        )}
        {!isSelf && (
          <ConfirmButton
            label="Xóa"
            variant="destructive"
            className="h-9"
            confirmText={`Xóa hẳn tài khoản ${a.username}? Không hoàn tác được. Điểm danh, sao và nhật ký đã ghi vẫn được giữ.`}
            action={deleteAccountAction}
            input={{ id: a.id }}
            successMessage="Đã xóa tài khoản."
          />
        )}
      </>
    );
  };

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold sm:text-2xl">
          Tài khoản{" "}
          <span className="text-sm font-normal text-muted-foreground">
            ({accounts.length === all.length ? all.length : `${accounts.length}/${all.length}`})
          </span>
        </h1>
        <FormDialogButton
          label="Thêm tài khoản"
          title="Thêm tài khoản"
          fields={[...accountFields(null), { name: "password", label: "Mật khẩu tạm", type: "password", required: true, hint: PASSWORD_HINT }]}
          initial={{ role: "teacher" }}
          action={createAccountAction}
          successMessage="Đã tạo tài khoản."
        />
      </div>

      <form className="flex flex-col gap-2 sm:flex-row" role="search">
        <Input name="q" defaultValue={paramText(params.q)} placeholder="Tìm theo tên đăng nhập, tên hiển thị…" aria-label="Tìm tài khoản" className="h-10 sm:max-w-sm" />
        <AutoSubmitSelect name="role" defaultValue={roleFilter} aria-label="Lọc theo vai trò" className="h-10 sm:max-w-56">
          <option value="">Tất cả vai trò</option>
          {roleChoices.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </AutoSubmitSelect>
        <Button type="submit" variant="outline" className="h-10">
          Tìm
        </Button>
      </form>

      {accounts.length === 0 ? (
        <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">Không có tài khoản phù hợp.</p>
      ) : (
        <>
          {/* Điện thoại: dạng thẻ. Màn hình rộng: dạng bảng. */}
          <ul className="grid gap-2 lg:hidden">
            {accounts.map((a, index) => (
              <li key={a.id} className="grid gap-2 glass-solid rounded-xl border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground tabular-nums">{index + 1}.</span>
                  <span className="font-medium">{a.username}</span>
                  <Badge variant={a.role === "admin" ? "default" : "secondary"}>{label(a.role)}</Badge>
                  {badges(a)}
                </div>
                <p className="text-muted-foreground">
                  {a.name}
                  {a.teacherName && ` · GV: ${a.teacherName}`}
                  {a.lastLoginAt && ` · đăng nhập gần nhất ${formatDateTime(a.lastLoginAt)}`}
                </p>
                <div className="flex flex-wrap gap-2">{actions(a)}</div>
              </li>
            ))}
          </ul>
          <div className="hidden glass-solid min-w-0 overflow-x-auto rounded-2xl border lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-14 text-center">STT</TableHead>
                  <TableHead>Tên đăng nhập</TableHead>
                  <TableHead>Tên hiển thị</TableHead>
                  <TableHead>Vai trò</TableHead>
                  <TableHead>Giáo viên</TableHead>
                  <TableHead>Trạng thái</TableHead>
                  <TableHead>Đăng nhập gần nhất</TableHead>
                  <TableHead>Thao tác</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a, index) => (
                  <TableRow key={a.id}>
                    <TableCell className="text-center text-muted-foreground tabular-nums">{index + 1}</TableCell>
                    <TableCell className="font-medium">{a.username}</TableCell>
                    <TableCell className="whitespace-normal">{a.name}</TableCell>
                    <TableCell>
                      <Badge variant={a.role === "admin" ? "default" : "secondary"}>{label(a.role)}</Badge>
                    </TableCell>
                    <TableCell className="whitespace-normal">{a.teacherName ?? ""}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">{isLocked(a) || a.mustChangePassword || a.twoFactorEnabled ? badges(a) : "Bình thường"}</div>
                    </TableCell>
                    <TableCell>{a.lastLoginAt ? formatDateTime(a.lastLoginAt) : "Chưa đăng nhập"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">{actions(a)}</div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
