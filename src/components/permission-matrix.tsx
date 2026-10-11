"use client";

import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { type ActionFn, selectClass } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ACTION_LABELS,
  type ClassScope,
  MAX_ROLES,
  type Menu,
  NO_PERMISSIONS,
  PERMISSION_ACTIONS,
  PERMISSION_MENUS,
  type PermissionAction,
  type PermissionConfig,
  ROLE_LABEL_MAX,
  SCOPE_LABELS,
  isBuiltinRole,
} from "@/lib/permissions";

const ROLE_HINTS: Record<string, string> = {
  teacher: "Tài khoản của giáo viên đứng lớp.",
  duty_teacher: "Tài khoản trực trung tâm: hỗ trợ điểm danh, nhắc giáo viên.",
};

/**
 * Một bảng phân quyền duy nhất: chọn vai trò ở ô "Vai trò" rồi tick Xem / Thêm / Sửa (và Xóa ở menu có hỗ trợ) theo menu.
 * Admin tạo thêm, đổi tên, xóa vai trò tại đây. Chỉ Admin dùng; máy chủ kiểm tra lại khi lưu.
 */
export function PermissionMatrix({
  initial,
  action,
  members,
}: {
  initial: PermissionConfig;
  action: ActionFn;
  /** Số tài khoản và tên giáo viên đang mang từng vai trò. */
  members: Record<string, { accounts: number; names: string[] }>;
}) {
  const [config, setConfig] = useState(initial);
  const [role, setRole] = useState(Object.keys(initial)[0] ?? "teacher");
  const [pending, startTransition] = useTransition();
  const dirty = JSON.stringify(config) !== JSON.stringify(initial);
  const keys = Object.keys(config);
  const current = config[role] ?? config[keys[0]!]!;
  const builtin = isBuiltinRole(role);
  const usage = members[role] ?? { accounts: 0, names: [] };
  const inUse = usage.accounts > 0;

  const patchRole = (patch: Partial<PermissionConfig[string]>) => setConfig((prev) => ({ ...prev, [role]: { ...prev[role]!, ...patch } }));

  function toggle(menu: Menu, act: PermissionAction, checked: boolean) {
    const item = current.menus[menu];
    // Bỏ Xem thì bỏ luôn Thêm/Sửa/Xóa; tick Thêm/Sửa/Xóa thì tự tick Xem.
    const cleared = { view: false, add: false, edit: false, ...("delete" in item ? { delete: false } : {}) };
    const next = act === "view" ? (checked ? { ...item, view: true } : cleared) : { ...item, [act]: checked, view: item.view || checked };
    patchRole({ menus: { ...current.menus, [menu]: next } });
  }

  function addRole() {
    const key = `role_${Date.now().toString(36)}`;
    const base = "Vai trò mới";
    const taken = new Set(Object.values(config).map((r) => r.label));
    let label = base;
    for (let n = 2; taken.has(label); n++) label = `${base} ${n}`;
    setConfig((prev) => ({ ...prev, [key]: { label, scope: NO_PERMISSIONS.scope, menus: structuredClone(NO_PERMISSIONS.menus), studentPrivate: false } }));
    setRole(key);
  }

  function removeRole() {
    if (!window.confirm(`Xóa vai trò "${current.label}"? Thay đổi có hiệu lực sau khi bấm Lưu phân quyền.`)) return;
    setConfig((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== role)));
    setRole(keys.find((key) => key !== role) ?? "teacher");
  }

  function save() {
    startTransition(async () => {
      const result = await action(config);
      if (result.ok) toast.success("Đã lưu phân quyền.");
      else toast.error(result.fieldErrors ? `${result.error} ${Object.values(result.fieldErrors)[0] ?? ""}` : result.error, { duration: 8000 });
    });
  }

  return (
    <div className="grid gap-4">
      <section className="grid gap-3 glass-solid rounded-2xl border p-3" aria-label={`Quyền của ${current.label}`}>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid min-w-0 flex-1 gap-1.5 text-sm font-medium sm:max-w-sm">
            Vai trò
            <select className={selectClass} value={role} aria-label="Vai trò" onChange={(event) => setRole(event.target.value)}>
              {keys.map((key) => (
                <option key={key} value={key}>
                  {config[key]!.label} ({members[key]?.accounts ?? 0} tài khoản)
                </option>
              ))}
            </select>
          </label>
          <Button type="button" variant="outline" className="h-11" disabled={keys.length >= MAX_ROLES} onClick={addRole}>
            <PlusIcon /> Thêm vai trò
          </Button>
          {!builtin && (
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={inUse}
              title={inUse ? "Vai trò đang được gán cho tài khoản hoặc giáo viên" : undefined}
              onClick={removeRole}
            >
              <Trash2Icon /> Xóa vai trò
            </Button>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">
            Tên vai trò
            <Input
              className="h-11"
              value={current.label}
              maxLength={ROLE_LABEL_MAX}
              disabled={builtin}
              aria-label="Tên vai trò"
              onChange={(event) => patchRole({ label: event.target.value })}
            />
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Phạm vi lớp được thấy
            <select
              className={selectClass}
              value={current.scope}
              aria-label="Phạm vi lớp được thấy"
              onChange={(event) => patchRole({ scope: event.target.value as ClassScope })}
            >
              {(Object.keys(SCOPE_LABELS) as ClassScope[]).map((scope) => (
                <option key={scope} value={scope}>
                  {SCOPE_LABELS[scope]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="text-sm text-muted-foreground">
          {builtin ? `${ROLE_HINTS[role]} Vai trò có sẵn: không đổi tên, không xóa được.` : "Vai trò do bạn tạo: đổi tên được; chỉ xóa được khi chưa gán cho ai."}{" "}
          {usage.names.length > 0 ? (
            <>
              Tài khoản mang vai trò này: <span className="text-foreground">{usage.names.join(", ")}</span>.
            </>
          ) : (
            "Chưa có tài khoản nào mang vai trò này."
          )}{" "}
          Gán vai trò ở cột Vai trò trong Admin → Tài khoản.
        </p>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-5 shrink-0 accent-primary"
            checked={current.studentPrivate === true}
            onChange={(event) => patchRole({ studentPrivate: event.target.checked })}
            aria-label={`${current.label}: Thông tin cá nhân học viên`}
          />
          <span>
            <span className="font-medium">Thông tin cá nhân học viên</span>
            <span className="block text-xs text-muted-foreground">
              Xem và sửa ngày sinh, giới tính, phụ huynh, điện thoại, ghi chú của học viên (ở QL Học viên và form học viên mới của Ghi danh). Không tick thì
              các ô này không hiện.
            </span>
          </span>
        </label>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th className="py-2 pr-2 font-medium">Menu</th>
                {PERMISSION_ACTIONS.map((act) => (
                  <th key={act} className="w-11 py-2 text-center font-medium">
                    {ACTION_LABELS[act]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PERMISSION_MENUS.map((menu) => (
                <tr key={menu.key} className="border-b last:border-0">
                  <td className="py-2 pr-2">
                    {menu.label}
                    {menu.hint && <span className="block text-xs text-muted-foreground">{menu.hint}</span>}
                  </td>
                  {PERMISSION_ACTIONS.map((act) => (
                    <td key={act} className="text-center">
                      {(menu.actions as readonly PermissionAction[]).includes(act) ? (
                        <input
                          type="checkbox"
                          className="size-5 align-middle accent-primary"
                          checked={current.menus[menu.key][act] === true}
                          onChange={(event) => toggle(menu.key, act, event.target.checked)}
                          aria-label={`${current.label}: ${ACTION_LABELS[act]} ${menu.label}`}
                        />
                      ) : (
                        <span className="text-muted-foreground" aria-hidden>
                          –
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" className="h-10" disabled={pending || !dirty} onClick={save}>
          Lưu phân quyền
        </Button>
        {dirty && <p className="text-sm text-muted-foreground">Có thay đổi chưa lưu (lưu một lần cho mọi vai trò).</p>}
      </div>
    </div>
  );
}
