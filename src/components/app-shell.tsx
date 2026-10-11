"use client";

import {
  AwardIcon,
  BanknoteIcon,
  BarChart3Icon,
  BookOpenIcon,
  BriefcaseIcon,
  Building2Icon,
  CalendarCheckIcon,
  CalendarDaysIcon,
  ChevronDownIcon,
  ClipboardCheckIcon,
  ClipboardListIcon,
  GiftIcon,
  GraduationCapIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  ListOrderedIcon,
  LogOutIcon,
  type LucideIcon,
  MenuIcon,
  SchoolIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldIcon,
  StarIcon,
  UserCogIcon,
  UsersIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { authClient } from "@/lib/auth-client";
import { hardNavigate } from "@/lib/navigate";
import { cn } from "@/lib/utils";

type NavItem = { href: string; label: string; icon: LucideIcon };
type NavGroupItem = { label: string; icon: LucideIcon; children: NavItem[] };
type NavEntry = NavItem | NavGroupItem;

const isGroup = (entry: NavEntry): entry is NavGroupItem => "children" in entry;
const isActive = (pathname: string, href: string) => pathname === href || pathname.startsWith(`${href}/`);

// Toàn bộ mục menu. Máy chủ quyết định người dùng thấy mục nào (theo vai trò và bảng phân quyền).
const NAV: { admin: NavEntry[]; teacher: NavItem[] } = {
  admin: [
    { href: "/admin/dashboard", label: "Tổng quan", icon: LayoutDashboardIcon },
    {
      label: "Giám đốc",
      icon: BriefcaseIcon,
      children: [
        { href: "/admin/courses", label: "Khóa học", icon: BookOpenIcon },
        { href: "/admin/rooms-slots", label: "Phòng & Ca học", icon: Building2Icon },
        { href: "/admin/teachers", label: "Giáo viên", icon: UsersIcon },
      ],
    },
    {
      label: "Admin",
      icon: ShieldIcon,
      children: [
        { href: "/admin/accounts", label: "Tài khoản", icon: UserCogIcon },
        { href: "/admin/settings", label: "Cấu hình", icon: SettingsIcon },
        { href: "/admin/audit", label: "Nhật ký", icon: ScrollTextIcon },
      ],
    },
    { href: "/admin/syllabus", label: "Syllabus", icon: ListOrderedIcon },
    { href: "/admin/classes", label: "Lớp học", icon: SchoolIcon },
    { href: "/admin/enrollments", label: "Ghi danh", icon: ClipboardListIcon },
    { href: "/admin/students", label: "QL Học viên", icon: GraduationCapIcon },
    { href: "/admin/timetable", label: "Thời khóa biểu", icon: CalendarDaysIcon },
    { href: "/admin/attendance", label: "Điểm danh", icon: ClipboardCheckIcon },
    {
      label: "Sao & Quà",
      icon: AwardIcon,
      children: [
        { href: "/admin/stars", label: "Sao", icon: StarIcon },
        { href: "/admin/rewards", label: "Quà & Tổng kết", icon: GiftIcon },
      ],
    },
    { href: "/admin/timesheet", label: "Chấm công", icon: CalendarCheckIcon },
    { href: "/admin/tuition", label: "Học phí", icon: BanknoteIcon },
    { href: "/admin/reports", label: "Báo cáo", icon: BarChart3Icon },
  ],
  teacher: [
    { href: "/teacher/dashboard", label: "Tổng quan", icon: LayoutDashboardIcon },
    { href: "/teacher/timetable", label: "TKB của tôi", icon: CalendarDaysIcon },
    { href: "/teacher/classes", label: "Lớp của tôi", icon: SchoolIcon },
  ],
};

// Dải icon (tablet 768–1279px): ẩn nhãn, canh icon vào giữa; nhãn vẫn còn cho trình đọc màn hình và làm chú thích.
const RAIL_ITEM = "md:max-xl:justify-center md:max-xl:px-0";
const RAIL_LABEL = "md:max-xl:sr-only";

// Chỉ tải trước trang khi người dùng rê chuột/chạm vào mục menu, thay vì tải trước cả menu ở mỗi lần mở trang.
function NavLink({ item, active, onNavigate, rail }: { item: NavItem; active: boolean; onNavigate?: () => void; rail?: boolean }) {
  const [intent, setIntent] = useState(false);
  const { href, label, icon: Icon } = item;
  return (
    <Link
      href={href}
      prefetch={intent ? null : false}
      onMouseEnter={() => setIntent(true)}
      onTouchStart={() => setIntent(true)}
      onFocus={() => setIntent(true)}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={rail ? label : undefined}
      className={cn(
        "relative flex min-h-11 items-center gap-3 rounded-full px-4 text-sm font-medium transition-colors",
        // Khi pill trượt đã định vị xong (data-pill="on") thì nền của mục đang chọn do pill đảm nhận.
        active
          ? "bg-sidebar-primary font-semibold text-sidebar-primary-foreground group-data-[pill=on]/nav:bg-transparent"
          : "hover:bg-sidebar-accent",
        rail && RAIL_ITEM,
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className={cn(rail && RAIL_LABEL)}>{label}</span>
    </Link>
  );
}

// Nhóm menu bấm để mở/đóng; tự mở khi trang hiện tại thuộc nhóm.
function NavGroup({
  group,
  pathname,
  onNavigate,
  rail,
}: {
  group: NavGroupItem;
  pathname: string;
  onNavigate?: () => void;
  rail?: boolean;
}) {
  const containsActive = group.children.some((item) => isActive(pathname, item.href));
  const [open, setOpen] = useState(containsActive);
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (containsActive) setOpen(true);
  }
  const Icon = group.icon;
  return (
    <div className="grid gap-1">
      <button
        type="button"
        aria-expanded={open}
        title={rail ? group.label : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "relative flex min-h-11 items-center gap-3 rounded-full px-4 text-left text-sm transition-colors hover:bg-sidebar-accent",
          containsActive ? "font-semibold" : "font-medium",
          rail && RAIL_ITEM,
          rail && open && "md:max-xl:bg-sidebar-accent",
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className={cn("flex-1", rail && RAIL_LABEL)}>{group.label}</span>
        <ChevronDownIcon className={cn("size-4 shrink-0 transition-transform", open && "rotate-180", rail && "md:max-xl:hidden")} aria-hidden />
      </button>
      {open && (
        <div className={cn("ml-4 grid gap-1 border-l border-sidebar-border pl-2", rail && "md:max-xl:ml-0 md:max-xl:border-l-0 md:max-xl:pl-0")}>
          {group.children.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} onNavigate={onNavigate} rail={rail} />
          ))}
        </div>
      )}
    </div>
  );
}

function NavLinks({ items, onNavigate, rail }: { items: NavEntry[]; onNavigate?: () => void; rail?: boolean }) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);

  // Pill teal trượt tới mục đang chọn: đo vị trí rồi chỉ đổi transform. Đo lại khi đổi trang
  // hoặc khi menu đổi kích thước (mở/đóng nhóm, đổi cỡ màn hình).
  useLayoutEffect(() => {
    const nav = navRef.current;
    const pill = pillRef.current;
    if (!nav || !pill) return;
    const place = () => {
      const active = nav.querySelector<HTMLElement>('a[aria-current="page"]');
      if (!active) {
        pill.style.opacity = "0";
        delete nav.dataset.pill;
        return;
      }
      const from = nav.getBoundingClientRect();
      const to = active.getBoundingClientRect();
      // Lần đầu đặt thẳng vào chỗ, không trượt từ góc trên xuống.
      const first = nav.dataset.pill !== "on";
      if (first) pill.style.transition = "none";
      pill.style.width = `${to.width}px`;
      pill.style.height = `${to.height}px`;
      pill.style.transform = `translate(${to.left - from.left}px, ${to.top - from.top}px)`;
      pill.style.opacity = "1";
      nav.dataset.pill = "on";
      if (first) {
        void pill.offsetWidth;
        pill.style.transition = "";
      }
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [pathname]);

  return (
    <nav ref={navRef} className="group/nav relative grid gap-1 p-2">
      <span
        ref={pillRef}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 rounded-full bg-sidebar-primary opacity-0 shadow-[0_6px_16px_-8px_var(--sidebar-primary)] transition-transform duration-300 ease-out motion-reduce:transition-none"
      />
      {items.map((entry) =>
        isGroup(entry) ? (
          <NavGroup key={entry.label} group={entry} pathname={pathname} onNavigate={onNavigate} rail={rail} />
        ) : (
          <NavLink key={entry.href} item={entry} active={isActive(pathname, entry.href)} onNavigate={onNavigate} rail={rail} />
        ),
      )}
    </nav>
  );
}

function AccountLinks({ userName, rail }: { userName: string; rail?: boolean }) {
  async function signOut() {
    await authClient.signOut();
    hardNavigate("/login");
  }
  return (
    <div className="grid gap-1 border-t border-sidebar-border p-2">
      <p className={cn("truncate px-4 py-1 text-xs text-sidebar-foreground/70", rail && "md:max-xl:hidden")}>{userName}</p>
      <Link
        href="/change-password"
        title={rail ? "Đổi mật khẩu" : undefined}
        className={cn("flex min-h-11 items-center gap-3 rounded-full px-4 text-sm transition-colors hover:bg-sidebar-accent", rail && RAIL_ITEM)}
      >
        <KeyRoundIcon className="size-4 shrink-0" aria-hidden />
        <span className={cn(rail && RAIL_LABEL)}>Đổi mật khẩu</span>
      </Link>
      <button
        type="button"
        onClick={signOut}
        title={rail ? "Đăng xuất" : undefined}
        className={cn("flex min-h-11 items-center gap-3 rounded-full px-4 text-left text-sm transition-colors hover:bg-sidebar-accent", rail && RAIL_ITEM)}
      >
        <LogOutIcon className="size-4 shrink-0" aria-hidden />
        <span className={cn(rail && RAIL_LABEL)}>Đăng xuất</span>
      </button>
    </div>
  );
}

export function AppShell({
  hrefs,
  labels,
  userName,
  children,
}: {
  /** Các mục menu được hiện, do máy chủ tính (xem `navFor`). */
  hrefs: string[];
  /** Nhãn thay thế theo href (vd. "Lớp của tôi" → "Lớp học" khi được xem mọi lớp). */
  labels?: Record<string, string>;
  userName: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // Hiệu ứng hiện dần chỉ dùng khi chuyển trang trong ứng dụng; lần tải đầu hiện ngay để không làm chậm nội dung chính.
  const pathname = usePathname();
  const [firstPath] = useState(pathname);
  const [navigated, setNavigated] = useState(false);
  if (!navigated && pathname !== firstPath) setNavigated(true);
  const visible = (list: NavItem[]) =>
    list.filter((item) => hrefs.includes(item.href)).map((item) => ({ ...item, label: labels?.[item.href] ?? item.label }));
  // Nhóm chỉ hiện khi còn ít nhất một mục con được phép.
  const items: NavEntry[] = [...NAV.teacher, ...NAV.admin].flatMap((entry): NavEntry[] => {
    if (!isGroup(entry)) return visible([entry]);
    const children = visible(entry.children);
    return children.length > 0 ? [{ ...entry, children }] : [];
  });
  // Logo có chữ màu navy nên phần đầu thanh điều hướng giữ nền trắng. `rail` = dải icon ở tablet: chỉ còn logo.
  const sidebarBrand = (rail: boolean) => (
    <div className={cn("flex items-center gap-3 bg-white px-4 py-3 text-foreground", rail && "md:max-xl:justify-center md:max-xl:px-1")}>
      <span className={cn("shrink-0", rail && "md:max-xl:w-12")}>
        <BrandLogo height={56} />
      </span>
      <span className={cn("text-sm leading-tight font-semibold text-muted-foreground", rail && "md:max-xl:hidden")}>
        Quản lý
        <br />
        trung tâm Robotics
      </span>
    </div>
  );

  return (
    // --sidebar-w: bề rộng thanh điều hướng ở từng mốc; thanh Lưu cố định của trang Điểm danh/Chấm sao dựa vào biến này.
    <div className="flex min-h-dvh flex-col md:flex-row md:[--sidebar-w:4.5rem] xl:[--sidebar-w:15rem]">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-white px-3 md:hidden print:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger render={<Button variant="ghost" size="icon" aria-label="Mở menu" />}>
            <MenuIcon />
          </SheetTrigger>
          <SheetContent side="left" className="w-72 gap-0 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground">
            <SheetHeader className="p-0">
              <SheetTitle>{sidebarBrand(false)}</SheetTitle>
            </SheetHeader>
            <div className="flex-1 overflow-y-auto">
              <NavLinks items={items} onNavigate={() => setOpen(false)} />
            </div>
            <AccountLinks userName={userName} />
          </SheetContent>
        </Sheet>
        <BrandLogo height={40} />
      </header>

      <aside className="glass-sidebar sticky top-0 hidden h-dvh w-(--sidebar-w) shrink-0 flex-col text-sidebar-foreground md:flex print:hidden">
        {sidebarBrand(true)}
        <div className="sidebar-scroll flex-1 overflow-y-auto">
          <NavLinks items={items} rail />
        </div>
        <AccountLinks userName={userName} rail />
      </aside>

      {/*
        Cửa sổ kính của vùng nội dung là lớp nền NẰM CẠNH <main>, không bọc nó: phần tử cha có backdrop-filter
        sẽ làm lệch các thanh position: fixed bên trong trang (thanh Lưu điểm danh, chấm sao).
      */}
      <div className="relative min-w-0 flex-1 md:p-3 xl:p-4 print:p-0">
        <div aria-hidden className="glass-window pointer-events-none absolute inset-0 md:inset-3 md:rounded-3xl xl:inset-4 print:hidden" />
        <main className={cn("relative min-w-0 p-3 sm:p-6 xl:p-8 print:p-0", navigated && "page-enter")}>{children}</main>
      </div>
    </div>
  );
}
