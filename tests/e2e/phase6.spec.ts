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

test("Giao diện: không tràn ngang ở tablet và màn hình rộng, thanh điều hướng đổi dạng theo cỡ màn hình, tắt hiệu ứng khi giảm chuyển động", async ({ page }) => {
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

  // 768px: thanh điều hướng thu thành dải icon, mục vẫn bấm được theo tên; từ 1280px hiện đủ nhãn.
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto("/admin/dashboard");
  const rail = page.locator("aside");
  expect((await rail.boundingBox())!.width).toBeLessThan(100);
  await rail.getByRole("link", { name: "Học viên" }).click();
  await expect(page).toHaveURL(/\/admin\/students$/);
  await expect(rail.getByRole("link", { name: "Học viên" })).toHaveAttribute("aria-current", "page");
  await page.setViewportSize({ width: 1280, height: 900 });
  expect((await rail.boundingBox())!.width).toBeGreaterThan(200);
  await expect(rail.getByText("Thời khóa biểu")).toBeVisible();

  // Giảm chuyển động: mọi animation của trang Tổng quan chạy xong tức thì, số KPI hiện ngay giá trị thật.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/admin/dashboard");
  await expect(page.getByRole("heading", { name: "Tổng quan trung tâm" })).toHaveCount(1);
  const longest = await page.evaluate(() =>
    Math.max(0, ...document.getAnimations().map((animation) => Number(animation.effect?.getComputedTiming().endTime ?? 0))),
  );
  expect(longest, "animation dài nhất khi bật giảm chuyển động (ms)").toBeLessThan(1);
  const kpi = page.getByRole("link", { name: /Học viên đang học/ });
  const shown = await kpi.textContent();
  expect(shown).toMatch(/Học viên đang học\s*[1-9]\d*$/);
  await page.waitForTimeout(900);
  expect(await kpi.textContent()).toBe(shown);

  expect(pageErrors).toEqual([]);
});

test("Tổng quan kiểu dashboard 3D: điện thoại không dựng cảnh; laptop có cảnh isometric với thanh trên, KPI, các thẻ nổi; tìm kiếm, nút camera, chọn phòng mở đúng buổi; giáo viên chỉ thấy buổi trong phạm vi", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

  // Một phòng riêng có buổi kéo dài cả ngày hôm nay (luôn "đang học" dù chạy lúc nào), do GV02 dạy, lớp có 1 học viên.
  const db = sql();
  const [base] = await db`select course_id from classes where code = 'RB-CB01'`;
  const [room] = await db`insert into rooms (name, capacity) values ('Phòng 3D E2E', 8) returning id`;
  const [cls] = await db`
    insert into classes (code, name, course_id, default_room_id, start_date, end_date, max_size)
    values ('3D-E2E', 'Lớp thử 3D', ${base!.course_id}, ${room!.id}, ${today}, ${today}, 8) returning id`;
  const [student] = await db`select id from students where code = 'HV001'`;
  await db`insert into enrollments (class_id, student_id, joined_at) values (${cls!.id}, ${student!.id}, ${today})`;
  const [teacher] = await db`select id from teachers where code = 'GV02'`;
  const [held] = await db`
    insert into sessions (class_id, date, start_time, end_time, room_id, teacher_id)
    values (${cls!.id}, ${today}, '00:00', '23:59', ${room!.id}, ${teacher!.id}) returning id`;

  try {
    const threeScripts: string[] = [];
    page.on("request", (request) => request.resourceType() === "script" && /three/i.test(request.url()) && threeScripts.push(request.url()));
    await login(page, "admin", NEW_PASSWORD);
    await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
    await page.getByRole("button", { name: "Xác nhận" }).click();
    await expect(page).toHaveURL(/\/admin\/dashboard$/);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    // Điện thoại 360px: một cột, không dựng cảnh, không tải thư viện 3D; số liệu và danh sách vẫn đủ.
    await expect(page.getByRole("link", { name: /Học viên đang học/ })).toBeVisible();
    const rooms = page.getByRole("region", { name: "Phòng học hôm nay" });
    await expect(rooms.locator('[data-room="Phòng 3D E2E"]')).toHaveAttribute("data-state", "live");
    await expect(page.getByRole("tab", { name: /^Hôm nay/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel").locator('[data-session="Lớp thử 3D"]')).toContainText("Đang học");
    await expect(page.locator("[data-day-percent]")).toHaveText(/^\d+%$/);
    await expect(page.getByRole("heading", { name: "Điểm danh 30 ngày qua" })).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.locator("[data-center-scene]")).toBeHidden();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.waitForLoadState("networkidle");
    expect(threeScripts, "điện thoại không tải thư viện 3D").toEqual([]);
    // Buổi hôm nay mở đúng trang buổi học.
    await page.getByRole("tabpanel").getByRole("link", { name: /Lớp thử 3D/ }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/sessions/${held!.id}$`));

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

    // KPI giữ các số và đường dẫn cũ.
    for (const name of ["Học viên đang học", "Giáo viên đang dạy", "Lớp đang mở", "Buổi quá hạn chưa điểm danh"]) {
      await expect(scene.getByRole("link", { name: new RegExp(name) })).toBeVisible();
    }

    // Phím "/" vào ô tìm kiếm; gõ không dấu vẫn ra; Enter chọn phòng của buổi tìm thấy.
    await page.keyboard.press("/");
    const search = bar.getByRole("searchbox");
    await expect(search).toBeFocused();
    await search.fill("thu 3d");
    await expect(bar.getByRole("list", { name: "Kết quả tìm kiếm" })).toContainText("Lớp thử 3D");
    await page.keyboard.press("Enter");
    await expect(rooms.getByRole("heading", { name: "Phòng 3D E2E" })).toBeVisible();
    await expect(rooms).toContainText("Sức chứa 8 chỗ · 1 buổi hôm nay");
    await expect(rooms).toContainText("Sĩ số 1/8");
    await expect(rooms).toContainText("GV: ");
    await expect(rooms.getByRole("link", { name: "Mở buổi học" })).toHaveAttribute("href", `/admin/sessions/${held!.id}`);
    // Không có tên hay mã học viên nào trong trang.
    await expect(page.getByText("HV001")).toHaveCount(0);
    // Nhãn của phòng trong cảnh là nút thật: cùng trạng thái, đang được chọn.
    const label = scene.getByRole("button", { name: "Phòng 3D E2E: Đang học, Lớp thử 3D" });
    await expect(label).toBeVisible();
    await expect(label).toHaveAttribute("aria-pressed", "true");

    // Cột nút điều khiển góc nhìn: mỗi nút làm cảnh đổi (nhãn của phòng dời chỗ hoặc đổi cỡ).
    const placed = () => label.evaluate((element) => (element as HTMLElement).style.transform);
    for (const name of ["Phóng to", "Xoay 45°", "Thu nhỏ", "Về tòa nhà chính", "Đặt lại góc nhìn"]) {
      const before = await placed();
      await page.getByRole("button", { name, exact: true }).click();
      await expect.poll(placed, { message: `nút ${name} đổi góc nhìn` }).not.toBe(before);
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(800);
    await page.screenshot({ path: "test-results/shots/stage-1366.png" });

    // Quay lại danh sách phòng; tab Quá hạn và tab Lớp đổi nội dung thẻ danh sách.
    await rooms.getByRole("button", { name: "Tất cả phòng" }).click();
    await expect(rooms.locator('[data-room="Phòng Lab 1"]')).toBeVisible();
    await page.getByRole("tab", { name: /^Quá hạn/ }).click();
    await expect(page.getByRole("tab", { name: /^Quá hạn/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel").locator('[data-session="Lớp thử 3D"]')).toHaveCount(0);
    await page.getByRole("tab", { name: /^Lớp/ }).click();
    await expect(page.getByRole("tabpanel")).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "Tiến trình các buổi học hôm nay" })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);

    // Bấm phòng ở danh sách rồi mở buổi học.
    await rooms.locator('[data-room="Phòng 3D E2E"]').click();
    await rooms.getByRole("link", { name: "Mở buổi học" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/sessions/${held!.id}$`));

    // 1024px: cảnh ở trên, các thẻ xếp bên dưới, không tràn ngang.
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/admin/dashboard");
    await expect(scene.locator("canvas")).toBeVisible({ timeout: 60_000 });
    await expect(rooms.locator('[data-room="Phòng 3D E2E"]')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);

    // Giáo viên khác (phạm vi lớp của mình): vẫn thấy phòng, nhưng không thấy buổi của lớp không phải của mình.
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const teacherPage = await context.newPage();
    teacherPage.on("pageerror", (error) => pageErrors.push(String(error)));
    await login(teacherPage, "gv.lan", NEW_PASSWORD);
    await expect(teacherPage).toHaveURL(/\/teacher\/dashboard$/);
    await expect(teacherPage.locator("[data-center-scene] canvas")).toBeVisible({ timeout: 60_000 });
    await expect(teacherPage.locator('[data-room="Phòng 3D E2E"]')).toHaveAttribute("data-state", "idle");
    await expect(teacherPage.getByText("Lớp thử 3D")).toHaveCount(0);
    await expect(teacherPage.getByRole("button", { name: /^Tài khoản: .+, Giáo viên$/ })).toBeVisible();
    await expect(teacherPage.locator("[data-center-scene]").getByRole("list", { name: "Số liệu chính" })).toContainText("Buổi học hôm nay");
    await teacherPage.screenshot({ path: "test-results/shots/stage-teacher-1366.png" });
    await context.close();

    expect(pageErrors).toEqual([]);
  } finally {
    await db`delete from classes where code = '3D-E2E'`;
    await db`delete from rooms where name = 'Phòng 3D E2E'`;
    await db.end();
  }
});
