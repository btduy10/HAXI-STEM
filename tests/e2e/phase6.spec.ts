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
  await expect(page.getByRole("heading", { name: /^Xin chào/ })).toBeVisible();
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

// Giao diện 3D đang tạm tắt trên bản chạy thật (CENTER_3D = false ở hai trang Tổng quan) nên bài này tạm ngưng tới khi bật lại.
test.fixme("Tổng quan: nút Xem 3D chỉ có từ laptop; cảnh 3D trung tâm hiện phòng và buổi hôm nay theo phạm vi của người dùng, bấm phòng mở được buổi học", async ({ page, browser }) => {
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
    await login(page, "admin", NEW_PASSWORD);
    await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
    await page.getByRole("button", { name: "Xác nhận" }).click();
    await expect(page).toHaveURL(/\/admin\/dashboard$/);

    // Điện thoại 360px: không có nút; mở thẳng địa chỉ thì chỉ có lời nhắn, không dựng cảnh và không tải thư viện 3D.
    await expect(page.getByRole("link", { name: "Xem 3D" })).toHaveCount(0);
    const threeScripts: string[] = [];
    page.on("request", (request) => request.resourceType() === "script" && /three/i.test(request.url()) && threeScripts.push(request.url()));
    await page.goto("/admin/dashboard?view=3d");
    await expect(page.getByText("Giao diện 3D dùng trên màn hình từ laptop trở lên.")).toBeVisible();
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.locator("[data-room]").filter({ visible: true })).toHaveCount(0);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.waitForLoadState("networkidle");
    expect(threeScripts, "điện thoại không tải thư viện 3D").toEqual([]);
    await page.getByRole("link", { name: "Giao diện thường" }).click();
    await expect(page).toHaveURL(/\/admin\/dashboard$/);
    await expect(page.getByRole("link", { name: /Học viên đang học/ })).toBeVisible();

    // Laptop 1366×768: nút Xem 3D ở lời chào, bấm thì đổi sang cảnh 3D.
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto("/admin/dashboard");
    await page.getByRole("link", { name: "Xem 3D" }).click();
    await expect(page).toHaveURL(/\/admin\/dashboard\?view=3d$/);
    const scene = page.locator("[data-center-scene]");
    await expect(scene.locator("canvas")).toBeVisible({ timeout: 60_000 });
    // Thư viện 3D chỉ được tải ở bước này.
    expect(threeScripts.length, "màn hình rộng tải thư viện 3D khi mở cảnh").toBeGreaterThan(0);

    // Bảng bên cạnh: mọi phòng, phòng thử đang học; bấm phòng hiện buổi hôm nay kèm đường mở buổi học.
    const roomButton = page.locator('[data-room="Phòng 3D E2E"]');
    await expect(roomButton).toHaveAttribute("data-state", "live");
    await expect(roomButton).toContainText("Đang học · 00:00–23:59 · Lớp thử 3D");
    await expect(roomButton).toContainText("8 chỗ");
    await expect(page.locator('[data-room="Phòng Lab 1"]')).toBeVisible();
    await roomButton.click();
    await expect(roomButton).toHaveAttribute("aria-pressed", "true");
    const detail = page.locator("aside section").filter({ has: page.getByRole("heading", { name: /Phòng 3D E2E/ }) });
    await expect(detail).toContainText("GV: ");
    await expect(detail).toContainText("Sĩ số 1/8");
    await expect(detail.getByText("Đang học")).toBeVisible();
    // Không có tên học viên nào trong trang.
    await expect(page.getByText("HV001")).toHaveCount(0);
    // Nhãn của phòng trong cảnh 3D là nút thật: cùng trạng thái, cùng phòng đang chọn.
    const label = scene.getByRole("button", { name: "Phòng 3D E2E: Đang học, Lớp thử 3D" });
    await expect(label).toBeVisible();
    await expect(label).toHaveAttribute("aria-pressed", "true");
    await expect(label).toContainText("Sĩ số 1/8");
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "test-results/shots/center-3d-1366.png" });

    await detail.getByRole("link", { name: "Mở buổi học" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/sessions/${held!.id}$`));
    await page.goBack();
    await expect(scene.locator("canvas")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("link", { name: "Giao diện thường" }).click();
    await expect(page).toHaveURL(/\/admin\/dashboard$/);
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Học viên đang học/ })).toBeVisible();

    // Giáo viên khác (phạm vi lớp của mình): vẫn thấy phòng, nhưng không thấy buổi của lớp không phải của mình.
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const teacherPage = await context.newPage();
    teacherPage.on("pageerror", (error) => pageErrors.push(String(error)));
    await login(teacherPage, "gv.lan", NEW_PASSWORD);
    await expect(teacherPage).toHaveURL(/\/teacher\/dashboard$/);
    await teacherPage.getByRole("link", { name: "Xem 3D" }).click();
    await expect(teacherPage).toHaveURL(/\/teacher\/dashboard\?view=3d$/);
    await expect(teacherPage.locator("[data-center-scene] canvas")).toBeVisible({ timeout: 60_000 });
    await expect(teacherPage.locator('[data-room="Phòng 3D E2E"]')).toHaveAttribute("data-state", "idle");
    await expect(teacherPage.getByText("Lớp thử 3D")).toHaveCount(0);
    await context.close();

    expect(pageErrors).toEqual([]);
  } finally {
    await db`delete from classes where code = '3D-E2E'`;
    await db`delete from rooms where name = 'Phòng 3D E2E'`;
    await db.end();
  }
});
