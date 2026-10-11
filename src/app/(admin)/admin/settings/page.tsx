import type { Metadata } from "next";
import { FormDialogButton } from "@/components/action-buttons";
import { PermissionMatrix } from "@/components/permission-matrix";
import { updateCenterInfoAction } from "@/server/actions/admin";
import { updatePermissionsAction, updateSettingsAction } from "@/server/actions/rewards";
import { listAccounts } from "@/server/services/accounts";
import { readPermissions, readSettings } from "@/server/services/reports";
import { readCenterInfo } from "@/server/services/tuition";
import { requirePageUser } from "@/server/session";

export const metadata: Metadata = { title: "Cấu hình" };

export default async function SettingsPage() {
  const { actor } = await requirePageUser("admin");
  const [settings, permissions, accounts, center] = await Promise.all([
    readSettings(actor),
    readPermissions(actor),
    listAccounts(actor),
    readCenterInfo(actor),
  ]);
  // Ai đang mang từng vai trò: các tài khoản được gán vai trò đó ở Admin → Tài khoản.
  const members = Object.fromEntries(
    Object.keys(permissions).map((role) => [
      role,
      {
        accounts: accounts.filter((a) => a.role === role).length,
        names: accounts.filter((a) => a.role === role).map((a) => `${a.username} (${a.name})`),
      },
    ]),
  );
  const items = [
    {
      label: "Khóa sửa điểm danh sau",
      value: `${settings.attendance_lock_days} ngày`,
      hint: "Quá số ngày này kể từ ngày học, chỉ sửa được điểm danh sau khi Admin mở khóa (mỗi lần 24 giờ).",
    },
    {
      label: "Trừ sao tối đa mỗi học viên mỗi buổi",
      value: `${settings.max_deduction_per_session} sao`,
      hint: "Các lần trừ đã hoàn tác không tính vào giới hạn.",
    },
  ];
  return (
    <div className="grid max-w-2xl gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold sm:text-2xl">Cấu hình</h1>
        <FormDialogButton
          label="Sửa cấu hình"
          title="Sửa cấu hình"
          fields={[
            { name: "attendance_lock_days", label: "Khóa sửa điểm danh sau (ngày)", type: "number", required: true },
            { name: "max_deduction_per_session", label: "Trừ sao tối đa mỗi buổi", type: "number", required: true },
          ]}
          initial={{
            attendance_lock_days: String(settings.attendance_lock_days),
            max_deduction_per_session: String(settings.max_deduction_per_session),
          }}
          action={updateSettingsAction}
        />
      </div>
      <dl className="grid gap-2">
        {items.map((item) => (
          <div key={item.label} className="glass-solid rounded-2xl border p-3">
            <dt className="text-sm text-muted-foreground">{item.label}</dt>
            <dd className="text-lg font-semibold">{item.value}</dd>
            <dd className="text-sm text-muted-foreground">{item.hint}</dd>
          </div>
        ))}
      </dl>

      <section className="grid gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Thông tin trung tâm</h2>
          <FormDialogButton
            label="Sửa thông tin"
            title="Thông tin trung tâm"
            description="In ở đầu giấy báo học phí và phiếu thu."
            fields={[
              { name: "name", label: "Tên trung tâm", required: true },
              { name: "address", label: "Địa chỉ" },
              { name: "phone", label: "Điện thoại" },
              { name: "bank", label: "Thông tin chuyển khoản", type: "textarea", hint: "Vd. ngân hàng, số tài khoản, chủ tài khoản." },
            ]}
            initial={center}
            action={updateCenterInfoAction}
          />
        </div>
        <dl className="grid gap-1 glass-solid rounded-2xl border p-3 text-sm">
          {[
            ["Tên trung tâm", center.name],
            ["Địa chỉ", center.address],
            ["Điện thoại", center.phone],
            ["Chuyển khoản", center.bank],
          ].map(([label, value]) => (
            <div key={label} className="flex gap-2">
              <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
              <dd className="min-w-0 break-words whitespace-pre-line">{value || "—"}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="grid gap-3">
        <div>
          <h2 className="text-lg font-semibold">Phân quyền</h2>
          <p className="text-sm text-muted-foreground">
            Chọn <strong>Vai trò</strong> rồi tick quyền cho vai trò đó; bấm <strong>Thêm vai trò</strong> để tạo vai trò mới dùng khi tạo
            tài khoản. Tick <strong>Xem</strong> để menu hiện trên thanh menu của vai trò đó; <strong>Thêm</strong>, <strong>Sửa</strong> mở các nút
            tương ứng. Quản trị luôn có toàn quyền. Xóa dữ liệu chỉ dành cho Quản trị, trừ menu có cột Xóa (Syllabus); các menu Tài khoản, Nhật ký, Cấu hình luôn chỉ dành cho Quản trị. Mọi
            vai trò ngoài Quản trị luôn có khu vực giảng dạy (Tổng quan, thời khóa biểu, lớp) trong phạm vi lớp đã chọn.
          </p>
        </div>
        <PermissionMatrix initial={permissions} action={updatePermissionsAction} members={members} />
      </section>
    </div>
  );
}