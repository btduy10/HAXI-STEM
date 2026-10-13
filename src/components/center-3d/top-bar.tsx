"use client";

import { BellIcon, Building2Icon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { AccountMenu, Disclosure, disclosureRowClass as rowClass } from "@/components/account-menu";
import { BrandLogo } from "@/components/brand-logo";
import { cn } from "@/lib/utils";

/** Một kết quả tìm kiếm; `key` cho biết loại và mã của đối tượng ("room|…", "session|…", "teacher|…", "student|…"). */
export type SearchResult = { key: string; title: string; detail: string };
export type OverdueItem = { id: string; title: string; detail: string; href: string; locked: boolean };

/**
 * Thanh trên của dashboard: logo và tên cơ sở, ô tìm kiếm (phím tắt "/"), chip "Live" kèm đồng hồ, chuông báo buổi quá hạn
 * chưa điểm danh, và tài khoản đang đăng nhập. Phòng, lớp, giáo viên lọc ngay trên dữ liệu hôm nay của trang; học viên do
 * trang gọi máy chủ tìm (theo quyền) rồi đưa vào `results`. Chip "Live" nháy mỗi khi `pulse` đổi (dữ liệu mới về).
 */
export function TopBar({
  className,
  now,
  user,
  query,
  onQuery,
  results,
  searching,
  searchError,
  emptyText,
  searchLabel,
  searchPlaceholder,
  onPick,
  pulse,
  overdue,
  overdueTotal,
  overdueHref,
}: {
  className?: string;
  /** Giờ Việt Nam hiện tại "HH:MM". */
  now: string;
  user: { name: string; role: string };
  query: string;
  onQuery: (value: string) => void;
  results: SearchResult[];
  /** Đang tìm học viên ở máy chủ, hoặc lỗi của lần tìm đó. */
  searching: boolean;
  searchError: string | null;
  /** Dòng ghi khi không có kết quả nào. */
  emptyText: string;
  searchLabel: string;
  searchPlaceholder: string;
  onPick: (result: SearchResult) => void;
  /** Dấu của dữ liệu trang; đổi là dữ liệu mới vừa về. */
  pulse: string;
  /** Vài buổi quá hạn mới nhất để liệt kê dưới chuông. */
  overdue: OverdueItem[];
  overdueTotal: number;
  /** Trang xem toàn bộ buổi quá hạn; null khi người dùng không có trang đó. */
  overdueHref: string | null;
}) {
  const input = useRef<HTMLInputElement>(null);
  // Phím "/" đưa con trỏ vào ô tìm kiếm, trừ khi đang gõ ở một ô nhập khác.
  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (!input.current || input.current.offsetParent === null) return;
      event.preventDefault();
      input.current.focus();
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, []);
  // Dữ liệu mới về: chip "Live" nháy một nhịp (tắt khi người dùng bật giảm chuyển động).
  const chip = useRef<HTMLParagraphElement>(null);
  const seen = useRef(pulse);
  useEffect(() => {
    if (seen.current === pulse) return;
    seen.current = pulse;
    const element = chip.current;
    if (!element) return;
    element.dataset.updates = String(Number(element.dataset.updates ?? "0") + 1);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    element.animate(
      [
        { boxShadow: "0 0 0 0 color-mix(in srgb, var(--primary) 55%, transparent)", backgroundColor: "var(--brand-gold-soft)" },
        { boxShadow: "0 0 0 10px transparent", backgroundColor: "var(--primary-soft)" },
      ],
      { duration: 900, iterations: 2, easing: "ease-out" },
    );
  }, [pulse]);

  return (
    <header className={cn("panel flex min-h-14 items-center gap-3 px-3 py-2", className)}>
      <div className="hidden shrink-0 items-center gap-2.5 md:flex">
        <BrandLogo height={38} />
        <div className="leading-tight">
          <p className="font-semibold">HAXI STEM</p>
          <p className="flex items-center gap-1 text-xs text-ink-soft">
            <Building2Icon className="size-3.5" aria-hidden />
            Trung tâm Robotics
          </p>
        </div>
      </div>

      <div role="search" className="relative hidden min-w-0 flex-1 md:block md:max-w-md">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-soft" aria-hidden />
        <input
          ref={input}
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && results[0]) onPick(results[0]);
            if (event.key === "Escape") {
              onQuery("");
              event.currentTarget.blur();
            }
          }}
          aria-label={searchLabel}
          placeholder={searchPlaceholder}
          className="h-10 w-full rounded-full border bg-background pr-10 pl-9 text-sm outline-none placeholder:text-ink-soft focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-ring/40"
        />
        <kbd className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded-md border bg-card px-1.5 text-xs text-ink-soft" aria-hidden>
          /
        </kbd>
        {query.trim() !== "" && (
          <ul aria-label="Kết quả tìm kiếm" className="panel absolute top-full right-0 left-0 z-40 mt-2 grid max-h-72 gap-1 overflow-y-auto p-2 text-sm">
            {results.map((result) => (
              <li key={result.key}>
                <button type="button" onClick={() => onPick(result)} className={cn(rowClass, "w-full flex-col items-start gap-0")}>
                  <span className="font-medium">{result.title}</span>
                  <span className="text-xs text-ink-soft">{result.detail}</span>
                </button>
              </li>
            ))}
            {searching ? (
              <li role="status" className="px-2.5 py-2 text-ink-soft">
                Đang tìm học viên…
              </li>
            ) : searchError ? (
              <li role="alert" className="px-2.5 py-2 text-danger">
                {searchError}
              </li>
            ) : (
              results.length === 0 && <li className="px-2.5 py-2 text-ink-soft">{emptyText}</li>
            )}
          </ul>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <p ref={chip} data-live-chip className="flex h-9 items-center gap-2 rounded-full bg-primary-soft px-3 text-sm font-medium text-primary-strong" aria-label={`Trực tiếp, bây giờ ${now}`}>
          <span aria-hidden className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60 motion-reduce:hidden" />
            <span className="relative inline-flex size-2 rounded-full bg-primary" />
          </span>
          Live
          <span className="tabular-nums" data-clock>
            {now}
          </span>
        </p>

        <Disclosure
          label={overdueTotal > 0 ? `Thông báo: ${overdueTotal} buổi quá hạn chưa điểm danh` : "Thông báo: không có buổi quá hạn"}
          triggerClassName="relative grid size-10 place-items-center rounded-full border bg-card hover:bg-primary-soft"
          trigger={
            <>
              <BellIcon className="size-[1.125rem]" aria-hidden />
              {overdueTotal > 0 && (
                <span aria-hidden className="absolute -top-1 -right-1 grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1 text-[0.6875rem] font-semibold text-white tabular-nums">
                  {overdueTotal > 99 ? "99+" : overdueTotal}
                </span>
              )}
            </>
          }
        >
          <p className="px-2.5 pt-1 text-xs font-medium text-ink-soft">Buổi quá hạn chưa điểm danh ({overdueTotal})</p>
          {overdue.length === 0 ? (
            <p className="px-2.5 py-2 text-ink-soft">Không có buổi nào quá hạn.</p>
          ) : (
            overdue.map((item) => (
              <Link key={item.id} href={item.href} className={cn(rowClass, "flex-col items-start gap-0")}>
                <span className="font-medium">{item.title}</span>
                <span className="text-xs text-ink-soft">
                  {item.detail}
                  {item.locked && " · đã khóa"}
                </span>
              </Link>
            ))
          )}
          {overdueHref && overdueTotal > overdue.length && (
            <Link href={overdueHref} className={cn(rowClass, "font-medium text-primary")}>
              Xem tất cả ở Điểm danh
            </Link>
          )}
        </Disclosure>

        <AccountMenu name={user.name} role={user.role} className="hidden md:flex" />
      </div>
    </header>
  );
}
