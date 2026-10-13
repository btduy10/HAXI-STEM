import { expect, test } from "@playwright/test";
import { NEW_PASSWORD, loadAdminSecret, login, sql, totp } from "./helpers";

// Chạy sau các phase trước (thứ tự tên tệp): admin đã đổi mật khẩu và bật 2FA.
test.describe.configure({ mode: "serial" });

const ADMIN_PAGES = [
  "/admin/dashboard",
  "/admin/courses",
  "/admin/rooms-slots",
  "/admin/teachers",
  "/admin/syllabus",
  "/admin/accounts",
  "/admin/settings",
  "/admin/audit",
  "/admin/students",
  "/admin/enrollments",
  "/admin/classes",
  "/admin/timetable",
  "/admin/timetable?view=month",
  "/admin/attendance",
  "/admin/stars",
  "/admin/rewards",
  "/admin/timesheet",
  "/admin/tuition",
  "/admin/reports",
];

test("Giao diện: không tràn ngang ở tablet và màn hình rộng; menu là dải icon ở mọi trang (rê chuột hiện tên và menu con, nút 3 gạch mở menu đầy đủ), tài khoản ở góc phải trên; tắt hiệu ứng khi giảm chuyển động", async ({ page }) => {
  test.setTimeout(240_000);
  // Lỗi JavaScript ở bất kỳ trang nào cũng làm hỏng bài kiểm tra.
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await login(page, "admin", NEW_PASSWORD);
  await expect(page).toHaveURL(/\/two-factor$/);
  await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);

  // Tablet (dải icon) và màn hình rộng: bảng dài phải cuộn trong khung, không đẩy rộng trang.
  for (const width of [768, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    for (const url of ADMIN_PAGES) {
      await page.goto(url);
      await expect(page.getByRole("status", { name: "Đang tải" })).toHaveCount(0);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${url} tràn ngang ở ${width}px`).toBeLessThanOrEqual(0);
    }
  }

  // Từ 768px mọi trang dùng cùng một dải icon (Tổng quan và trang thường như nhau, kể cả ở 1280px); mục vẫn bấm được theo tên.
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/admin/dashboard");
  const rail = page.locator("aside");
  expect((await rail.boundingBox())!.width).toBeLessThan(100);
  await rail.getByRole("link", { name: "Học viên" }).click();
  await expect(page).toHaveURL(/\/admin\/students$/);
  await expect(rail.getByRole("link", { name: "Học viên" })).toHaveAttribute("aria-current", "page");
  await page.setViewportSize({ width: 1280, height: 900 });
  expect((await rail.boundingBox())!.width).toBeLessThan(100);
  // Góc trái dưới không còn Đổi mật khẩu, Đăng xuất.
  await expect(rail.getByText("Đăng xuất")).toHaveCount(0);
  await expect(rail.getByText("Đổi mật khẩu")).toHaveCount(0);
  // Rê chuột một icon: tên mục hiện ở bên phải.
  await rail.getByRole("link", { name: "Thời khóa biểu" }).hover();
  await expect(page.locator("[data-nav-tip]")).toHaveText("Thời khóa biểu");
  // Rê chuột icon nhóm: menu con có chữ, bấm để đi và khung tự đóng.
  await rail.getByRole("button", { name: "Giám đốc" }).hover();
  const flyout = page.locator('[data-nav-flyout="Giám đốc"]');
  await expect(flyout.getByRole("link")).toHaveText(["Khóa học", "Phòng & Ca học", "Giáo viên"]);
  await flyout.getByRole("link", { name: "Khóa học" }).click();
  await expect(page).toHaveURL(/\/admin\/courses$/);
  await expect(flyout).toHaveCount(0);
  // Nút 3 gạch: menu đầy đủ có chữ trượt ra, nhóm của trang đang mở xổ sẵn; chọn một mục thì đóng và chuyển trang.
  await rail.getByRole("button", { name: "Mở menu" }).click();
  const fullMenu = page.getByRole("dialog");
  await expect(fullMenu.getByRole("link", { name: "Khóa học" })).toHaveAttribute("aria-current", "page");
  await expect(fullMenu.getByText("Đăng xuất")).toHaveCount(0);
  // Menu đầy đủ hẹp (12rem) để ít che nội dung; tên mục dài nhất vẫn hiện đủ, không bị cắt.
  expect((await fullMenu.boundingBox())!.width).toBeLessThanOrEqual(200);
  expect(await fullMenu.evaluate((menu) => [...menu.querySelectorAll("nav span")].filter((label) => label.scrollWidth > label.clientWidth).map((label) => label.textContent))).toEqual([]);
  await fullMenu.getByRole("link", { name: "Thời khóa biểu" }).click();
  await expect(page).toHaveURL(/\/admin\/timetable$/);
  await expect(fullMenu).toHaveCount(0);
  // Nút tài khoản ở góc phải trên của trang thường: Đổi mật khẩu, Đăng xuất; Escape đóng khung.
  await page.getByRole("button", { name: /^Tài khoản: .+, Quản trị$/ }).click();
  await expect(page.getByRole("link", { name: "Đổi mật khẩu" })).toHaveAttribute("href", "/change-password");
  await expect(page.getByRole("button", { name: "Đăng xuất" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Đăng xuất" })).toHaveCount(0);
  // Thanh trên của trang thường tự ẩn như ở ứng dụng điện thoại: cuộn xuống thì trượt khỏi màn hình, cuộn lên thì hiện lại
  // ngay giữa trang (không cần về đầu trang), nút tài khoản dùng được.
  await page.goto("/admin/audit");
  const topBar = page.locator("header").filter({ hasText: "Trung tâm Robotics" });
  await expect(topBar).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)).toBeGreaterThan(700);
  // Cuộn rồi chờ hai khung hình để trang kịp xử lý lần cuộn đó trước lần cuộn kế tiếp.
  const scrollTo = (y: number) =>
    page.evaluate((top) => {
      window.scrollTo(0, top);
      return new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    }, y);
  // Khung trang hiện trước khi trang kịp gắn sự kiện cuộn nên cuộn lại từ đầu cho tới khi thanh ẩn.
  await expect(async () => {
    await scrollTo(0);
    await scrollTo(600);
    await expect(topBar).not.toBeInViewport({ timeout: 1000 });
  }).toPass();
  await scrollTo(450);
  await expect(topBar).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(450);
  await topBar.getByRole("button", { name: /^Tài khoản: / }).click();
  await expect(topBar.getByRole("button", { name: "Đăng xuất" })).toBeVisible();
  await page.keyboard.press("Escape");

  // Giảm chuyển động: mọi animation của trang Tổng quan chạy xong tức thì, số KPI hiện ngay giá trị thật.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/admin/dashboard");
  await expect(page.getByRole("heading", { name: "Tổng quan trung tâm" })).toHaveCount(1);
  const longest = await page.evaluate(() =>
    Math.max(0, ...document.getAnimations().map((animation) => Number(animation.effect?.getComputedTiming().endTime ?? 0))),
  );
  expect(longest, "animation dài nhất khi bật giảm chuyển động (ms)").toBeLessThan(1);
  const kpi = page.locator('[data-kpi="Học viên hôm nay"] [data-kpi-value]').filter({ visible: true });
  const shown = await kpi.textContent();
  expect(shown).toMatch(/^\d+$/);
  // Các số chung của trung tâm nằm ở hàng phía trên biểu đồ, vẫn dẫn tới trang của chúng.
  await expect(page.getByRole("link", { name: /^[1-9]\d*\s*học viên đang học$/ })).toHaveAttribute("href", "/admin/students");
  await page.waitForTimeout(900);
  expect(await kpi.textContent()).toBe(shown);

  // Điện thoại: menu trượt không còn Đăng xuất; nút tài khoản nằm trên thanh trên cùng, đăng xuất thì về trang đăng nhập.
  await page.emulateMedia({ reducedMotion: null });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/admin/timetable");
  const drawer = page.getByRole("dialog");
  await expect(async () => {
    await page.getByRole("button", { name: "Mở menu" }).click();
    await expect(drawer).toBeVisible({ timeout: 1000 });
  }).toPass();
  await expect(drawer.getByRole("link", { name: "Thời khóa biểu" })).toHaveAttribute("aria-current", "page");
  await expect(drawer.getByText("Đăng xuất")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await page.getByRole("button", { name: /^Tài khoản: .+, Quản trị$/ }).click();
  await expect(page.getByRole("link", { name: "Đổi mật khẩu" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "Đăng xuất" }).click();
  await expect(page).toHaveURL(/\/login$/);

  expect(pageErrors).toEqual([]);
});

test("Tổng quan kiểu dashboard 3D nối dữ liệu thật: điện thoại không dựng cảnh; laptop có cảnh isometric, KPI có so sánh, chọn phòng → thẻ lớp, học viên, giáo viên, các bước của buổi; tìm kiếm; điểm danh và ghi sao ngay trên trang; giáo viên chỉ thấy và làm được trong phạm vi lớp của mình", async ({ page, browser }) => {
  test.setTimeout(360_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

  // Hai phòng riêng, mỗi phòng một buổi kéo dài cả ngày hôm nay (luôn "đang học" dù chạy lúc nào), mỗi lớp 1 học viên:
  // "Lớp thử 3D" do GV02 dạy (không phải lớp của gv.lan), "Lớp của Lan 3D" do GV01 (gv.lan) dạy.
  const db = sql();
  const [base] = await db`select course_id from classes where code = 'RB-CB01'`;
  const seedClass = async (roomName: string, code: string, name: string, studentCode: string, teacherCode: string) => {
    const [room] = await db`insert into rooms (name, capacity) values (${roomName}, 8) returning id`;
    const [cls] = await db`
      insert into classes (code, name, course_id, default_room_id, start_date, end_date, max_size)
      values (${code}, ${name}, ${base!.course_id}, ${room!.id}, ${today}, ${today}, 8) returning id`;
    const [student] = await db`select id, full_name from students where code = ${studentCode}`;
    await db`insert into enrollments (class_id, student_id, joined_at) values (${cls!.id}, ${student!.id}, ${today})`;
    // Tên giáo viên hiện trên dashboard là tên gọi ngắn nếu có.
    const [teacher] = await db`select id, coalesce(nullif(short_name, ''), full_name) as full_name from teachers where code = ${teacherCode}`;
    const [held] = await db`
      insert into sessions (class_id, date, start_time, end_time, room_id, teacher_id)
      values (${cls!.id}, ${today}, '00:00', '23:59', ${room!.id}, ${teacher!.id}) returning id`;
    return { sessionId: held!.id as string, studentName: student!.full_name as string, teacherName: teacher!.full_name as string };
  };
  const other = await seedClass("Phòng 3D E2E", "3D-E2E", "Lớp thử 3D", "HV001", "GV02");
  const mine = await seedClass("Phòng 3D Lan", "3D-E2E2", "Lớp của Lan 3D", "HV002", "GV01");

  try {
    const threeScripts: string[] = [];
    page.on("request", (request) => request.resourceType() === "script" && /three/i.test(request.url()) && threeScripts.push(request.url()));
    // Chọn sẵn cảnh 3D: máy chạy kiểm thử ít nhân xử lý thì mặc định là giao diện nhẹ.
    await page.addInitScript(() => window.localStorage.setItem("haxi.dashboard.view", "3d"));
    await login(page, "admin", NEW_PASSWORD);
    await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
    await page.getByRole("button", { name: "Xác nhận" }).click();
    await expect(page).toHaveURL(/\/admin\/dashboard$/);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const detail = page.locator("[data-detail-panel]");
    const lists = page.getByRole("tabpanel");

    // Điện thoại 360px: một cột, không dựng cảnh, không tải thư viện 3D; số liệu, danh sách và chi tiết vẫn đủ.
    await expect(page.getByRole("link", { name: /học viên đang học/ })).toBeVisible();
    await expect(detail.locator('[data-room="Phòng 3D E2E"]')).toHaveAttribute("data-state", "live");
    await expect(page.getByRole("tab", { name: /^Lớp/ })).toHaveAttribute("aria-selected", "true");
    await expect(lists.locator('[data-session="Lớp thử 3D"]')).toContainText("Đang học");
    await expect(page.locator("[data-day-percent]")).toHaveText(/^\d+%$/);
    await expect(page.getByRole("heading", { name: "Điểm danh 30 ngày qua" })).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.locator("[data-center-scene]")).toBeHidden();
    // Trang mới mở không có tên hay mã học viên nào: chi tiết chỉ tải khi mở một buổi.
    await expect(page.getByText("HV001")).toHaveCount(0);
    await expect(page.getByText(other.studentName)).toHaveCount(0);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.waitForLoadState("networkidle");
    expect(threeScripts, "điện thoại không tải thư viện 3D").toEqual([]);
    // Bấm một lớp ở danh sách: thẻ chi tiết hiện lớp đó kèm học viên; từ đó mở đúng trang buổi học.
    await lists.locator('[data-session="Lớp thử 3D"] button').click();
    await expect(detail.locator('[data-class-detail="Lớp thử 3D"]')).toBeVisible();
    await expect(detail.locator(`[data-student="${other.studentName}"]`)).toContainText("HV001");
    expect(await overflow()).toBeLessThanOrEqual(0);
    await detail.getByRole("link", { name: "Mở buổi học" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/sessions/${other.sessionId}$`));

    // Laptop 1366×768: cảnh 3D isometric làm nền, các thẻ nổi lên trên.
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/admin/dashboard");
    const scene = page.locator("[data-center-scene]");
    await expect(scene.locator("canvas")).toBeVisible({ timeout: 60_000 });
    await expect(scene.getByRole("status")).toHaveCount(0, { timeout: 60_000 });
    expect(threeScripts.length, "màn hình rộng tải thư viện 3D").toBeGreaterThan(0);
    // Thanh điều hướng thu thành dải icon để nhường chỗ cho cảnh.
    expect((await page.locator("aside").first().boundingBox())!.width).toBeLessThan(100);

    // Thanh trên: logo, tìm kiếm, Live + đồng hồ, chuông, tài khoản kèm vai trò.
    const bar = page.locator("header").filter({ hasText: "Live" });
    await expect(bar.getByRole("img", { name: "HAXI STEM" })).toBeVisible();
    await expect(bar.locator("[data-clock]")).toHaveText(/^\d{2}:\d{2}$/);
    await expect(bar.getByRole("button", { name: /^Thông báo: / })).toBeVisible();
    const account = bar.getByRole("button", { name: /^Tài khoản: .+, Quản trị$/ });
    await account.click();
    await expect(bar.getByRole("link", { name: "Đổi mật khẩu" })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Đăng xuất" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(bar.getByRole("button", { name: "Đăng xuất" })).toHaveCount(0);

    // KPI: học viên hôm nay, tỉ lệ điểm danh, sao trong tuần (có so sánh kỳ trước) và buổi quá hạn.
    for (const name of ["Học viên hôm nay", "Tỉ lệ điểm danh tuần này", "Sao đã trao trong tuần", "Buổi quá hạn chưa điểm danh"]) {
      await expect(scene.locator(`[data-kpi="${name}"]`)).toBeVisible();
    }
    await expect(scene.locator('[data-kpi="Học viên hôm nay"] [data-kpi-delta]')).toContainText(/so với cùng thứ tuần trước/);
    const starsKpi = scene.locator('[data-kpi="Sao đã trao trong tuần"] [data-kpi-value]');
    const starsBefore = Number(await starsKpi.textContent());

    // Phím "/" vào ô tìm kiếm; gõ không dấu vẫn ra; Enter chọn lớp tìm thấy: thẻ chi tiết đổi sang lớp đó.
    await page.keyboard.press("/");
    const search = bar.getByRole("searchbox");
    await expect(search).toBeFocused();
    await search.fill("thu 3d");
    await expect(bar.getByRole("list", { name: "Kết quả tìm kiếm" })).toContainText("Lớp thử 3D");
    await page.keyboard.press("Enter");
    await expect(detail.getByRole("heading", { name: "Phòng 3D E2E" })).toBeVisible();
    await expect(detail).toContainText("Sức chứa 8 chỗ · 1 buổi hôm nay");
    const card = detail.locator('[data-class-detail="Lớp thử 3D"]');
    await expect(card).toContainText("1/8");
    await expect(card).toContainText(other.teacherName);
    await expect(card).toContainText("Chưa điểm danh");
    await expect(card.getByRole("link", { name: "Mở buổi học" })).toHaveAttribute("href", `/admin/sessions/${other.sessionId}`);
    await expect(detail.locator(`[data-student="${other.studentName}"]`)).toContainText("HV001 · Chưa điểm danh");
    // Nhãn của phòng trong cảnh là nút thật: cùng trạng thái, đang được chọn.
    // Tên truy cập của nhãn gồm phần chữ đang hiện, thêm trạng thái cho trình đọc màn hình.
    const label = scene.getByRole("button", { name: /^Phòng 3D E2E ?: Đang học, Lớp thử 3D/ });
    await expect(label).toBeVisible();
    await expect(label).toHaveAttribute("aria-pressed", "true");
    // Thẻ tiến trình đổi sang năm bước của buổi đang chọn.
    const steps = page.locator("[data-session-steps] [data-step]");
    await expect(steps).toHaveCount(5);
    await expect(page.locator('[data-step="scheduled"]')).toHaveAttribute("data-step-state", "done");
    await expect(page.locator('[data-step="attendance"]')).toHaveAttribute("data-step-state", "current");
    await expect(page.locator('[data-step="live"]')).toHaveAttribute("data-step-state", "current");
    await expect(page.locator('[data-step="finished"]')).toHaveAttribute("data-step-state", "pending");

    // Cột nút điều khiển góc nhìn: mỗi nút làm cảnh đổi (nhãn của phòng dời chỗ hoặc đổi cỡ).
    await page.waitForTimeout(1300);
    const placed = () => label.evaluate((element) => (element as HTMLElement).style.transform);
    for (const name of ["Phóng to", "Xoay 45°", "Thu nhỏ", "Về tòa nhà chính", "Đặt lại góc nhìn"]) {
      const before = await placed();
      await page.getByRole("button", { name, exact: true }).click();
      await expect.poll(placed, { message: `nút ${name} đổi góc nhìn` }).not.toBe(before);
      await page.waitForTimeout(700);
    }

    // Bấm học viên: máy quay bay tới (nhãn phòng dời chỗ), hình người được đánh dấu kèm nhãn tên, thẻ đổi sang học viên.
    const beforeFlight = await placed();
    await detail.locator(`[data-student="${other.studentName}"] button`).click();
    await expect(detail.getByRole("heading", { name: other.studentName })).toBeVisible();
    await expect(detail.getByRole("heading", { name: "Lịch sử điểm danh" })).toBeVisible();
    await expect(detail.locator("[data-student-total]")).toContainText("tổng sao");
    await expect(detail.getByRole("link", { name: "Mở hồ sơ đầy đủ" })).toHaveAttribute("href", /^\/admin\/students\/[0-9a-f-]{36}$/);
    await expect(scene.locator("[data-scene-marker]")).toHaveText(other.studentName);
    await expect.poll(placed, { message: "chọn học viên thì máy quay bay tới" }).not.toBe(beforeFlight);
    await page.waitForTimeout(1300);
    await page.screenshot({ path: "test-results/shots/stage-1366.png" });
    await detail.getByRole("button", { name: "Quay lại Lớp thử 3D" }).click();

    // Bấm giáo viên: các lớp phụ trách trong tuần.
    await card.getByRole("button", { name: other.teacherName }).click();
    await expect(detail.getByRole("heading", { name: other.teacherName })).toBeVisible();
    await expect(detail.locator('[data-teacher-class="Lớp thử 3D"]')).toContainText("Dạy chính");
    await expect(scene.locator("[data-scene-marker]")).toHaveText(other.teacherName);
    await detail.getByRole("button", { name: "Quay lại Lớp thử 3D" }).click();

    // Tab Giáo viên và tab Học viên; bấm dòng nào thì thẻ chi tiết đổi theo.
    await page.getByRole("tab", { name: /^Học viên/ }).click();
    await expect(lists).toContainText(other.studentName);
    await page.getByRole("tab", { name: /^Giáo viên/ }).click();
    await lists.locator(`[data-teacher="${other.teacherName}"] button`).click();
    await expect(detail.getByRole("heading", { name: other.teacherName })).toBeVisible();
    await page.getByRole("tab", { name: /^Lớp/ }).click();
    await lists.locator('[data-session="Lớp thử 3D"] button').click();
    await expect(card).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);

    // Tìm học viên theo mã: máy chủ tìm theo quyền; chọn kết quả mở thẻ học viên.
    await page.locator("h1").focus();
    await page.keyboard.press("/");
    await search.fill("HV001");
    const hits = bar.getByRole("list", { name: "Kết quả tìm kiếm" });
    await expect(hits.getByRole("button", { name: new RegExp(`${other.studentName}.*Học viên · HV001`) })).toBeVisible();
    await hits.getByRole("button", { name: new RegExp(other.studentName) }).click();
    await expect(detail.getByRole("heading", { name: "Lịch sử điểm danh" })).toBeVisible();
    await detail.getByRole("button", { name: /^Quay lại/ }).click();

    // Điểm danh ngay trên trang (đúng bảng và action của trang Điểm danh): lưu xong các thẻ tự cập nhật.
    const chip = bar.locator("[data-live-chip]");
    await card.getByRole("button", { name: "Điểm danh" }).click();
    const drawer = page.locator("[data-session-workspace]");
    await expect(drawer.getByRole("heading", { name: "3D-E2E – Lớp thử 3D" })).toBeVisible();
    await expect(drawer.getByRole("radiogroup", { name: `Điểm danh ${other.studentName}` }).getByRole("radio", { name: "Có mặt" })).toHaveAttribute("aria-checked", "true");
    await drawer.getByRole("button", { name: "Lưu điểm danh" }).click();
    await expect(page.getByText("Đã lưu điểm danh.")).toBeVisible();
    // Ghi sao ngay trên trang (đúng bảng và action của trang Ghi sao).
    await drawer.getByRole("tab", { name: "Ghi sao" }).click();
    await drawer.getByRole("checkbox", { name: `Chọn ${other.studentName}` }).click();
    await drawer.getByRole("button", { name: "Ghi sao", exact: true }).click();
    await page.getByRole("button", { name: /Sáng tạo vượt yêu cầu/ }).click();
    await expect(page.getByText(/Đã ghi \+5 sao/)).toBeVisible();
    await expect(drawer.getByRole("heading", { name: /Sổ ghi sao của buổi/ })).toContainText("(1)");
    await drawer.getByRole("button", { name: "Đóng" }).click();
    await expect(drawer).toHaveCount(0);
    // Thẻ lớp, các bước, nhãn của phòng, KPI và chip Live đều nhận dữ liệu mới mà không tải lại trang.
    await expect(card.locator("[data-attendance-rate]")).toContainText("100%");
    await expect(detail.locator(`[data-student="${other.studentName}"]`)).toContainText("Có mặt");
    await expect(detail.locator(`[data-student="${other.studentName}"]`)).toContainText("+5");
    await expect(page.locator('[data-step="attendance"]')).toHaveAttribute("data-step-state", "done");
    await expect(page.locator('[data-step="stars"]')).toHaveAttribute("data-step-state", "done");
    await expect(label).toContainText("đã điểm danh");
    await expect(starsKpi).toHaveText(String(starsBefore + 5));
    expect(Number(await chip.getAttribute("data-updates")), "chip Live nháy khi có dữ liệu mới").toBeGreaterThan(0);
    const [saved] = await db`select count(*)::int as n from attendances where session_id = ${other.sessionId}`;
    expect(saved!.n).toBe(1);

    // Quay lại danh sách phòng rồi chọn phòng ở danh sách, mở buổi học.
    await detail.getByRole("button", { name: "Tất cả phòng" }).click();
    await expect(detail.locator('[data-room="Phòng Lab 1"]')).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "Tiến trình các buổi học hôm nay" })).toBeVisible();
    await detail.locator('[data-room="Phòng 3D E2E"]').click();
    await detail.getByRole("link", { name: "Mở buổi học" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/sessions/${other.sessionId}$`));

    // 1024px: cảnh ở trên, các thẻ xếp bên dưới, không tràn ngang.
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/admin/dashboard");
    await expect(scene.locator("canvas")).toBeVisible({ timeout: 60_000 });
    await expect(detail.locator('[data-room="Phòng 3D E2E"]')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);

    // Giáo viên gv.lan (phạm vi lớp của mình): thấy phòng, nhưng không thấy lớp, giáo viên hay học viên của lớp không phải của mình.
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await context.addInitScript(() => window.localStorage.setItem("haxi.dashboard.view", "3d"));
    const teacherPage = await context.newPage();
    teacherPage.on("pageerror", (error) => pageErrors.push(String(error)));
    await login(teacherPage, "gv.lan", NEW_PASSWORD);
    await expect(teacherPage).toHaveURL(/\/teacher\/dashboard$/);
    const teacherScene = teacherPage.locator("[data-center-scene]");
    await expect(teacherScene.locator("canvas")).toBeVisible({ timeout: 60_000 });
    await expect(teacherScene.getByRole("status")).toHaveCount(0, { timeout: 60_000 });
    const teacherDetail = teacherPage.locator("[data-detail-panel]");
    await expect(teacherDetail.locator('[data-room="Phòng 3D E2E"]')).toHaveAttribute("data-state", "idle");
    await expect(teacherPage.getByText("Lớp thử 3D")).toHaveCount(0);
    await expect(teacherPage.getByRole("button", { name: /^Tài khoản: .+, Giáo viên$/ })).toBeVisible();
    await expect(teacherScene.getByRole("list", { name: "Số liệu chính" })).toContainText("Học viên hôm nay");
    // Phòng trống của lớp khác: mở ra không có buổi, không có học viên.
    await teacherDetail.locator('[data-room="Phòng 3D E2E"]').click();
    await expect(teacherDetail).toContainText("Hôm nay phòng không có buổi học.");
    await expect(teacherPage.getByText(other.studentName)).toHaveCount(0);
    await teacherDetail.getByRole("button", { name: "Tất cả phòng" }).click();
    // Tìm học viên của lớp khác: không ra; tìm học viên của lớp mình: ra.
    const teacherBar = teacherPage.locator("header").filter({ hasText: "Live" });
    const teacherSearch = teacherBar.getByRole("searchbox");
    await teacherSearch.fill("3D");
    const teacherHits = teacherBar.getByRole("list", { name: "Kết quả tìm kiếm" });
    await expect(teacherHits).toContainText("Lớp của Lan 3D");
    await expect(teacherHits).not.toContainText("Lớp thử 3D");
    await teacherSearch.fill("HV002");
    await expect(teacherHits.getByRole("button", { name: new RegExp(mine.studentName) })).toBeVisible();
    await teacherSearch.fill("");
    // Lớp của mình: thẻ lớp có học viên; điểm danh ngay trên trang bằng quyền của giáo viên.
    await teacherDetail.locator('[data-room="Phòng 3D Lan"]').click();
    const teacherCard = teacherDetail.locator('[data-class-detail="Lớp của Lan 3D"]');
    await expect(teacherDetail.locator(`[data-student="${mine.studentName}"]`)).toContainText("HV002 · Chưa điểm danh");
    await teacherCard.getByRole("button", { name: "Điểm danh" }).click();
    const teacherDrawer = teacherPage.locator("[data-session-workspace]");
    await teacherDrawer.getByRole("radiogroup", { name: `Điểm danh ${mine.studentName}` }).getByRole("radio", { name: "Đi trễ" }).click();
    await teacherDrawer.getByRole("button", { name: "Lưu điểm danh" }).click();
    await expect(teacherPage.getByText("Đã lưu điểm danh.")).toBeVisible();
    await expect(teacherDrawer.getByRole("tab", { name: "Ghi sao" })).toBeVisible();
    await teacherDrawer.getByRole("button", { name: "Đóng" }).click();
    await expect(teacherDetail.locator(`[data-student="${mine.studentName}"]`)).toContainText("Đi trễ");
    await expect(teacherCard.locator("[data-attendance-rate]")).toContainText("100%");
    // Thẻ học viên của lớp mình: không có thông tin cá nhân (chỉ mã, lớp, sao, điểm danh).
    await teacherDetail.locator(`[data-student="${mine.studentName}"] button`).click();
    await expect(teacherDetail.getByRole("heading", { name: "Lịch sử điểm danh" })).toBeVisible();
    await expect(teacherDetail).toContainText("Đi trễ");
    await expect(teacherDetail.getByRole("link", { name: "Mở hồ sơ đầy đủ" })).toHaveAttribute("href", /^\/teacher\/students\/[0-9a-f-]{36}$/);
    await expect(teacherDetail).not.toContainText(/Phụ huynh|Điện thoại|Ngày sinh/);
    await teacherPage.waitForTimeout(1300);
    await teacherPage.screenshot({ path: "test-results/shots/stage-teacher-1366.png" });
    await context.close();

    expect(pageErrors).toEqual([]);
  } finally {
    // Sổ sao chỉ xóa được khi bật cờ của Admin trong cùng giao dịch (trigger ở CSDL).
    await db.begin(async (tx) => {
      await tx`select set_config('haxi.star_logs_admin_delete', 'on', true)`;
      await tx`delete from star_logs where session_id in (${other.sessionId}, ${mine.sessionId})`;
    });
    await db`delete from classes where code in ('3D-E2E', '3D-E2E2')`;
    await db`delete from rooms where name in ('Phòng 3D E2E', 'Phòng 3D Lan')`;
    await db.end();
  }
});

test("Cảnh 3D sống và giao diện nhẹ: chuyển động nền, tắt khi giảm chuyển động, rê chuột đổi con trỏ, chùm sao khi buổi được ghi sao, đổi sang sơ đồ 2D không tải thư viện 3D, tự dùng giao diện nhẹ khi WebGL lỗi", async ({ page, browser }) => {
  test.setTimeout(300_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

  // Một phòng có buổi kéo dài cả ngày hôm nay (luôn "đang học"), lớp có 1 học viên.
  const db = sql();
  const [base] = await db`select course_id from classes where code = 'RB-CB01'`;
  const [room] = await db`insert into rooms (name, capacity) values ('Phòng Sống E2E', 8) returning id`;
  const [cls] = await db`
    insert into classes (code, name, course_id, default_room_id, start_date, end_date, max_size)
    values ('LIVE-E2E', 'Lớp cảnh sống', ${base!.course_id}, ${room!.id}, ${today}, ${today}, 8) returning id`;
  const [student] = await db`select id from students where code = 'HV003'`;
  await db`insert into enrollments (class_id, student_id, joined_at) values (${cls!.id}, ${student!.id}, ${today})`;
  const [teacher] = await db`select id from teachers where code = 'GV02'`;
  const [held] = await db`
    insert into sessions (class_id, date, start_time, end_time, room_id, teacher_id)
    values (${cls!.id}, ${today}, '00:00', '23:59', ${room!.id}, ${teacher!.id}) returning id`;

  try {
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.addInitScript(() => window.localStorage.getItem("haxi.dashboard.view") ?? window.localStorage.setItem("haxi.dashboard.view", "3d"));
    await login(page, "admin", NEW_PASSWORD);
    await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
    await page.getByRole("button", { name: "Xác nhận" }).click();
    await expect(page).toHaveURL(/\/admin\/dashboard$/);
    const scene = page.locator("[data-center-scene]");
    const canvas = scene.locator("canvas");
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    await expect(scene.getByRole("status")).toHaveCount(0, { timeout: 60_000 });
    const frames = () => canvas.evaluate((element) => Number((element as HTMLElement).dataset.frames ?? 0));

    // Chuyển động nền (robot tuần tra, người đi lại): cảnh được vẽ liên tục.
    await page.waitForTimeout(1500);
    const before = await frames();
    await page.waitForTimeout(2500);
    expect((await frames()) - before, "số khung hình vẽ trong 2,5 giây khi có chuyển động nền").toBeGreaterThan(5);

    // Rê chuột vào một đối tượng bấm được của cảnh: con trỏ thành bàn tay; rời ra thì trả lại.
    const area = (await canvas.boundingBox())!;
    let pointer = false;
    for (let x = area.x + 180; x < area.x + area.width - 380 && !pointer; x += 36) {
      for (let y = area.y + 190; y < area.y + area.height - 60 && !pointer; y += 36) {
        await page.mouse.move(x, y);
        pointer = (await page.evaluate(() => document.body.style.cursor)) === "pointer";
      }
    }
    expect(pointer, "rê chuột vào phòng hoặc hình người thì con trỏ đổi dạng").toBe(true);
    await page.mouse.move(area.x + 4, area.y + area.height - 4);
    await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe("");

    // Buổi vừa được ghi sao (ở đây: ghi từ nơi khác) thì lần làm mới kế tiếp cảnh bật chùm sao.
    expect(await canvas.getAttribute("data-star-bursts")).toBeNull();
    await db`insert into star_logs (session_id, student_id, stars) values (${held!.id}, ${student!.id}, 2)`;
    await expect(canvas).toHaveAttribute("data-star-bursts", "1", { timeout: 45_000 });

    // Đổi sang giao diện nhẹ: sơ đồ 2D thay cho canvas; chọn phòng vẫn mở thẻ lớp; lựa chọn được nhớ sau khi tải lại.
    await page.getByRole("button", { name: "Chuyển sang giao diện nhẹ" }).click();
    const flat = page.locator("[data-center-flat]");
    await expect(flat.getByRole("group", { name: "Sơ đồ trung tâm (giao diện nhẹ)" })).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Phóng to", exact: true })).toHaveCount(0);
    const flatRoom = flat.locator('[data-flat-room="Phòng Sống E2E"]');
    await expect(flatRoom).toHaveAttribute("data-state", "live");
    await flatRoom.click();
    await expect(flatRoom).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('[data-detail-panel] [data-class-detail="Lớp cảnh sống"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    const threeScripts: string[] = [];
    page.on("request", (request) => request.resourceType() === "script" && /three/i.test(request.url()) && threeScripts.push(request.url()));
    await page.reload();
    await expect(flat).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("canvas")).toHaveCount(0);
    expect(threeScripts, "giao diện nhẹ không tải thư viện 3D").toEqual([]);
    await page.screenshot({ path: "test-results/shots/stage-flat-1366.png" });
    // Đổi lại cảnh 3D.
    await page.getByRole("button", { name: "Chuyển sang cảnh 3D" }).click();
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    await expect(flat).toHaveCount(0);

    // Giảm chuyển động: không có chuyển động nền, cảnh đứng yên thì không vẽ khung nào.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    await expect(scene.getByRole("status")).toHaveCount(0, { timeout: 60_000 });
    await page.waitForTimeout(3000);
    const still = await frames();
    await page.waitForTimeout(3000);
    expect((await frames()) - still, "số khung hình vẽ trong 3 giây khi bật giảm chuyển động").toBe(0);

    // Trình duyệt không tạo được WebGL: trang tự dùng giao diện nhẹ, nút đổi sang 3D bị khóa, mọi thẻ vẫn dùng được.
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await context.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
        return /webgl/i.test(kind) ? null : (original as (...args: unknown[]) => unknown).call(this, kind, ...rest);
      } as typeof original;
      window.localStorage.setItem("haxi.dashboard.view", "3d");
    });
    const blocked = await context.newPage();
    blocked.on("pageerror", (error) => pageErrors.push(String(error)));
    await login(blocked, "gv.lan", NEW_PASSWORD);
    await expect(blocked).toHaveURL(/\/teacher\/dashboard$/);
    await expect(blocked.locator("[data-center-flat]")).toBeVisible();
    await expect(blocked.locator("canvas")).toHaveCount(0);
    await expect(blocked.getByRole("button", { name: "Máy này không hiển thị được cảnh 3D" })).toBeDisabled();
    await expect(blocked.locator("[data-detail-panel]")).toBeVisible();
    await context.close();

    expect(pageErrors).toEqual([]);
  } finally {
    await db.begin(async (tx) => {
      await tx`select set_config('haxi.star_logs_admin_delete', 'on', true)`;
      await tx`delete from star_logs where session_id = ${held!.id}`;
    });
    await db`delete from classes where code = 'LIVE-E2E'`;
    await db`delete from rooms where name = 'Phòng Sống E2E'`;
    await db.end();
  }
});
