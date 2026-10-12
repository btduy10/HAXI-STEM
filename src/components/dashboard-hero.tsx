/** Cành lá trang trí ở góc tiêu đề Tổng quan: chỉ hiện từ 1024px, không nhận chuột, không che nội dung. */
function LeafSprig() {
  // Mỗi lá: vị trí gốc lá trên cành, góc xoay và cỡ.
  const leaves = [
    { x: 204, y: 22, r: -58, s: 0.8 },
    { x: 182, y: 36, r: 34, s: 0.95 },
    { x: 158, y: 48, r: -64, s: 1.05 },
    { x: 132, y: 62, r: 30, s: 1.15 },
    { x: 106, y: 74, r: -68, s: 1.2 },
    { x: 78, y: 88, r: 26, s: 1.25 },
    { x: 50, y: 100, r: -72, s: 1.15 },
    { x: 26, y: 110, r: 20, s: 1 },
  ];
  return (
    <svg
      aria-hidden
      viewBox="0 0 240 130"
      className="pointer-events-none absolute -top-6 right-0 hidden h-28 w-52 opacity-80 lg:block xl:h-32 xl:w-60"
      fill="none"
    >
      <defs>
        <linearGradient id="leaf-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7fc8a0" />
          <stop offset="1" stopColor="#2e7d5b" />
        </linearGradient>
      </defs>
      <path d="M232 8 C 170 34, 96 70, 6 122" stroke="#2e7d5b" strokeWidth="1.6" strokeLinecap="round" opacity="0.7" />
      {leaves.map((leaf) => (
        <g key={`${leaf.x}-${leaf.y}`} transform={`translate(${leaf.x} ${leaf.y}) rotate(${leaf.r}) scale(${leaf.s})`}>
          <path d="M0 0 C 7 -9, 22 -11, 32 0 C 22 11, 7 9, 0 0 Z" fill="url(#leaf-fill)" opacity="0.85" />
          <path d="M1 0 L 29 0" stroke="#ffffff" strokeWidth="0.7" opacity="0.55" strokeLinecap="round" />
        </g>
      ))}
    </svg>
  );
}

/**
 * Lời chào đầu trang Tổng quan: tiêu đề lớn kiểu hero, một dòng mô tả và đường kẻ mảnh phân vùng.
 * `action`: nút đổi giao diện (Xem 3D / Giao diện thường), chỉ hiện từ 1024px.
 */
export function DashboardHero({ name, description, action }: { name: string; description: string; action?: React.ReactNode }) {
  return (
    <header className="relative grid gap-1.5 border-b pb-5 lg:pr-60">
      <h1 className="text-[clamp(1.625rem,1.15rem+2.1vw,2.875rem)] leading-[1.15] font-medium tracking-tight break-words">
        Xin chào, {name}
      </h1>
      <p className="text-sm text-muted-foreground sm:text-base">{description}</p>
      {action && <div className="mt-2 hidden lg:block">{action}</div>}
      <LeafSprig />
    </header>
  );
}
