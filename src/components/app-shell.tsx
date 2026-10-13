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
  LayoutDashboardIcon,
  ListOrderedIcon,
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
import { Dialog } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import { Tooltip } from "@base-ui/react/tooltip";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";
import { AccountMenu } from "@/components/account-menu";
import { BrandLogo } from "@/components/brand-logo";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
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
    { href: "/admin/classes", label: "Lớp học", icon: SchoolIcon },
    { href: "/admin/syllabus", label: "Syllabus", icon: ListOrderedIcon },
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

const isStage = (pathname: string) => pathname.endsWith("/dashboard");

const itemClass = "relative flex min-h-11 items-center gap-2.5 rounded-full px-3 text-sm transition-colors outline-none focus-visible:ring-3 focus-visible:ring-sidebar-ring/60";
// Dải icon: ẩn nhãn, canh icon vào giữa; nhãn vẫn còn cho trình đọc màn hình, và hiện ra trong khung nổi khi rê chuột.
const railItemClass = "justify-center px-0";
// Khung nổi bên phải dải icon (tên mục, menu con của nhóm): cùng màu với thanh điều hướng.
const flyoutClass =
  "rounded-2xl border border-sidebar-border bg-sidebar text-sidebar-foreground shadow-lg outline-none transition-opacity duration-100 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none";

// Chỉ tải trước trang khi người dùng rê chuột/chạm vào mục menu, thay vì tải trước cả menu ở mỗi lần mở trang.
// `rail`: mục chỉ có icon trong dải icon, rê chuột hoặc Tab tới thì tên mục hiện ở bên phải.
function NavLink({ item, active, onNavigate, rail }: { item: NavItem; active: boolean; onNavigate?: () => void; rail?: boolean }) {
  const [intent, setIntent] = useState(false);
  const { href, label, icon: Icon } = item;
  const link = (
    <Link
      href={href}
      prefetch={intent ? null : false}
      onMouseEnter={() => setIntent(true)}
      onTouchStart={() => setIntent(true)}
      onFocus={() => setIntent(true)}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        itemClass,
        "font-medium",
        // Khi pill trượt đã định vị xong (data-pill="on") thì nền của mục đang chọn do pill đảm nhận.
        active
          ? "bg-sidebar-primary font-semibold text-sidebar-primary-foreground group-data-[pill=on]/nav:bg-transparent"
          : "hover:bg-sidebar-accent",
        rail && railItemClass,
      )}
    >
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className={cn(rail ? "sr-only" : "truncate")}>{label}</span>
    </Link>
  );
  if (!rail) return link;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={link} />
      <Tooltip.Portal>
        <Tooltip.Positioner side="right" sideOffset={10} className="z-50">
          {/* Tên mục đã có trong đường dẫn (sr-only) nên khung nổi không đọc lại lần nữa. */}
          <Tooltip.Popup aria-hidden data-nav-tip className={cn(flyoutClass, "px-3 py-1.5 text-sm font-medium")}>
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

// Nhóm menu trong menu đầy đủ: bấm để mở/đóng; tự mở khi trang hiện tại thuộc nhóm.
function NavGroup({ group, pathname, onNavigate }: { group: NavGroupItem; pathname: string; onNavigate?: () => void }) {
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
        onClick={() => setOpen((value) => !value)}
        className={cn(itemClass, "text-left hover:bg-sidebar-accent", containsActive ? "font-semibold" : "font-medium")}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 truncate">{group.label}</span>
        <ChevronDownIcon className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="ml-3 grid gap-1 border-l border-sidebar-border pl-1">
          {group.children.map((item) => (
            <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} onNavigate={onNavigate} />
          ))}
        </div>
      )}
    </div>
  );
}

// Nhóm menu trong dải icon: rê chuột hoặc bấm vào icon thì menu con (tên nhóm và các mục có chữ) hiện ở bên phải.
// Icon nhóm được tô khi trang hiện tại thuộc nhóm.
function RailGroup({ group, pathname }: { group: NavGroupItem; pathname: string }) {
  const containsActive = group.children.some((item) => isActive(pathname, item.href));
  const [open, setOpen] = useState(false);
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(false);
  }
  const Icon = group.icon;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        openOnHover
        delay={80}
        closeDelay={150}
        className={cn(
          itemClass,
          railItemClass,
          containsActive ? "bg-sidebar-primary font-semibold text-sidebar-primary-foreground" : "font-medium hover:bg-sidebar-accent data-popup-open:bg-sidebar-accent",
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="sr-only">{group.label}</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="right" align="start" sideOffset={10} className="z-50">
          <Popover.Popup data-nav-flyout={group.label} className={cn(flyoutClass, "grid w-56 gap-1 p-2")}>
            <Popover.Title className="px-3 pt-1 pb-0.5 text-xs font-semibold tracking-wide text-sidebar-foreground/70 uppercase">{group.label}</Popover.Title>
            {group.children.map((item) => (
              <NavLink key={item.href} item={item} active={isActive(pathname, item.href)} onNavigate={() => setOpen(false)} />
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function NavLinks({ items, onNavigate, rail }: { items: NavEntry[]; onNavigate?: () => void; rail?: boolean }) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);

  // Pill teal trượt tới mục đang chọn: đo vị trí rồi chỉ đổi transform. Đo lại khi đổi trang
  // hoặc khi menu đổi kích thước (mở/đóng nhóm, đổi cỡ màn hình). Trong dải icon, mục con của nhóm không nằm
  // trong dải nên pill ẩn và icon nhóm tự tô.
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

  const nav = (
    <nav ref={navRef} className="group/nav relative grid gap-1 p-2">
      <span
        ref={pillRef}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 rounded-full bg-sidebar-primary opacity-0 shadow-[0_6px_16px_-8px_var(--sidebar-primary)] transition-transform duration-300 ease-out motion-reduce:transition-none"
      />
      {items.map((entry) =>
        !isGroup(entry) ? (
          <NavLink key={entry.href} item={entry} active={isActive(pathname, entry.href)} onNavigate={onNavigate} rail={rail} />
        ) : rail ? (
          <RailGroup key={entry.label} group={entry} pathname={pathname} />
        ) : (
          <NavGroup key={entry.label} group={entry} pathname={pathname} onNavigate={onNavigate} />
        ),
      )}
    </nav>
  );
  // Rê chuột từ mục này sang mục kế bên thì tên hiện ngay, không chờ lại.
  return rail ? <Tooltip.Provider delay={150}>{nav}</Tooltip.Provider> : nav;
}

export function AppShell({
  hrefs,
  labels,
  userName,
  userRole,
  children,
}: {
  /** Các mục menu được hiện, do máy chủ tính (xem `navFor`). */
  hrefs: string[];
  /** Nhãn thay thế theo href (vd. "Lớp của tôi" → "Lớp học" khi được xem mọi lớp). */
  labels?: Record<string, string>;
  userName: string;
  /** Tên vai trò để ghi cạnh tên trong khung của nút tài khoản. */
  userRole: string;
  children: React.ReactNode;
}) {
  // Menu đầy đủ (trượt ra từ trái) có hai nút mở: nút 3 gạch ở thanh trên của điện thoại và ở đầu dải icon.
  const [menu] = useState(() => Dialog.createHandle());
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
  // Trang Tổng quan kiểu dashboard 3D: vùng nội dung tràn hết khung (không có cửa sổ kính) và có thanh trên của nó.
  const stage = isStage(pathname);

  return (
    // --sidebar-w: bề rộng thanh điều hướng ở từng mốc; thanh Lưu cố định của trang Điểm danh/Chấm sao dựa vào biến này.
    <div className="flex min-h-dvh flex-col md:flex-row md:[--sidebar-w:4.5rem]">
      <Sheet handle={menu}>
        {/* Rộng 12rem (nửa bề rộng cũ ở máy tính): vừa đủ cho tên mục dài nhất, bớt che nội dung. */}
        <SheetContent side="left" className="gap-0 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground data-[side=left]:w-48">
          <SheetHeader className="p-0">
            {/* Logo có chữ màu navy nên phần đầu menu giữ nền trắng. */}
            <SheetTitle>
              <div className="flex items-center gap-2 bg-white py-2.5 pr-10 pl-3 text-foreground">
                <span className="shrink-0">
                  <BrandLogo height={44} />
                </span>
                <span className="text-xs leading-tight font-semibold text-muted-foreground">
                  Quản lý
                  <br />
                  trung tâm Robotics
                </span>
              </div>
            </SheetTitle>
          </SheetHeader>
          <div className="sidebar-scroll flex-1 overflow-y-auto">
            <NavLinks items={items} onNavigate={() => menu.close()} />
          </div>
        </SheetContent>
      </Sheet>

      {/* z-40: khung của nút tài khoản phải nằm trên thanh trên của trang Tổng quan (z-30) ở ngay bên dưới. */}
      <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b bg-white px-3 md:hidden print:hidden">
        <SheetTrigger handle={menu} render={<Button variant="ghost" size="icon" aria-label="Mở menu" />}>
          <MenuIcon />
        </SheetTrigger>
        <BrandLogo height={40} />
        <div className="ml-auto">
          <AccountMenu name={userName} role={userRole} compact />
        </div>
      </header>

      {/*
        Dải icon dùng cho mọi trang từ 768px. Từ mốc này chỉ trang Tổng quan có thanh trên (logo, nút tài khoản để đổi mật khẩu
        và đăng xuất); các trang khác dành trọn chiều cao cho nội dung.
      */}
      <aside className="glass-sidebar sticky top-0 hidden h-dvh w-(--sidebar-w) shrink-0 flex-col text-sidebar-foreground md:flex print:hidden">
        <div className="grid p-2 pb-0">
          <SheetTrigger handle={menu} aria-label="Mở menu" className={cn(itemClass, railItemClass, "hover:bg-sidebar-accent")}>
            <MenuIcon className="size-5" aria-hidden />
          </SheetTrigger>
        </div>
        <div className="sidebar-scroll flex-1 overflow-y-auto">
          <NavLinks items={items} rail />
        </div>
      </aside>

      {/*
        Cửa sổ kính của vùng nội dung là lớp nền NẰM CẠNH <main>, không bọc nó: phần tử cha có backdrop-filter
        sẽ làm lệch các thanh position: fixed bên trong trang (thanh Lưu điểm danh, chấm sao).
      */}
      {stage ? (
        <div className="relative min-w-0 flex-1">
          <main className={cn("relative min-w-0", navigated && "page-enter")}>{children}</main>
        </div>
      ) : (
        <div className="relative min-w-0 flex-1 md:p-3 xl:p-4 print:p-0">
          <div aria-hidden className="glass-window pointer-events-none absolute inset-0 md:inset-3 md:rounded-3xl xl:inset-4 print:hidden" />
          <main className={cn("relative min-w-0 p-3 sm:p-6 xl:p-8 print:p-0", navigated && "page-enter")}>{children}</main>
        </div>
      )}
    </div>
  );
}
