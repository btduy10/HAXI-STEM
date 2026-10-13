"use client";

import { KeyRoundIcon, LogOutIcon } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { hardNavigate } from "@/lib/navigate";
import { cn } from "@/lib/utils";

/** Nút mở một khung nhỏ bên dưới (thông báo, tài khoản). Đóng khi bấm ra ngoài, nhấn Escape hoặc chọn một mục bên trong. */
export function Disclosure({
  label,
  trigger,
  triggerClassName,
  children,
}: {
  /** Tên truy cập của nút khi nút chỉ có biểu tượng; bỏ trống khi phần chữ trong nút đã là tên. */
  label?: string;
  trigger: ReactNode;
  triggerClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className={cn("outline-none focus-visible:ring-3 focus-visible:ring-ring/50", triggerClassName)}
      >
        {trigger}
      </button>
      {open && (
        // Bấm một đường dẫn hoặc nút bên trong thì đóng khung.
        <div
          id={panelId}
          onClick={(event) => (event.target as HTMLElement).closest("a, button") && setOpen(false)}
          className="panel absolute top-full right-0 z-40 mt-2 grid w-72 max-w-[calc(100vw-1.5rem)] gap-1 p-2 text-sm"
        >
          {children}
        </div>
      )}
    </div>
  );
}

export const disclosureRowClass =
  "flex min-h-10 items-center gap-2 rounded-xl px-2.5 py-1.5 text-left outline-none hover:bg-primary-soft focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * Nút tài khoản ở góc phải trên: chữ cái đầu của tên (kèm tên và vai trò từ 1024px), bấm ra Đổi mật khẩu và Đăng xuất.
 * `compact`: chỉ hiện chữ cái đầu ở mọi bề rộng (thanh trên của điện thoại).
 */
export function AccountMenu({ name, role, compact, className }: { name: string; role?: string; compact?: boolean; className?: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  async function signOut() {
    await authClient.signOut();
    hardNavigate("/login");
  }
  return (
    <Disclosure
      triggerClassName={cn("flex h-10 items-center gap-2 rounded-full border bg-card p-1 hover:bg-primary-soft", !compact && "lg:pr-3", className)}
      trigger={
        <>
          <span aria-hidden className="grid size-8 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
            {initial}
          </span>
          {/* Tên truy cập "Tài khoản: tên, vai trò": màn hình hẹp đọc từ dòng ẩn, màn hình rộng đọc chính phần chữ đang hiện. */}
          <span className="sr-only">Tài khoản: </span>
          <span className={cn("sr-only", !compact && "lg:hidden")}>{role ? `${name}, ${role}` : name}</span>
          {!compact && (
            <span className="hidden max-w-36 text-left leading-tight lg:grid">
              <span className="truncate text-sm font-medium">
                {name}
                {role && <span className="sr-only">, </span>}
              </span>
              {role && <span className="truncate text-xs text-ink-soft">{role}</span>}
            </span>
          )}
        </>
      }
    >
      {/* Nút chỉ có chữ cái đầu (điện thoại, tablet) thì khung ghi rõ tên và vai trò. */}
      <p className={cn("truncate px-2.5 pt-1 text-xs font-medium text-ink-soft", !compact && "lg:hidden")}>{role ? `${name} · ${role}` : name}</p>
      <Link href="/change-password" className={disclosureRowClass}>
        <KeyRoundIcon className="size-4" aria-hidden />
        Đổi mật khẩu
      </Link>
      <button type="button" onClick={signOut} className={cn(disclosureRowClass, "w-full")}>
        <LogOutIcon className="size-4" aria-hidden />
        Đăng xuất
      </button>
    </Disclosure>
  );
}
