import { expect, test } from "@playwright/test";
import { NEW_PASSWORD, SEED_PASSWORD, expectNoHorizontalScroll, expectNotFound, firstLogin, login, saveAdminSecret, sql, totp, visibleText } from "./helpers";

// Các test chạy tuần tự trên cùng CSDL test và phụ thuộc thứ tự (đổi mật khẩu, bật 2FA).
test.describe.configure({ mode: "serial" });

test("chưa đăng nhập bị chuyển về trang đăng nhập, có header bảo mật", async ({ page }) => {
  const response = await page.goto("/admin/students");
  await expect(page).toHaveURL(/\/login$/);
  const headers = response!.headers();
  expect(headers["content-security-policy"]).toContain("script-src 'self' 'nonce-");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  await expectNoHorizontalScroll(page);

  // Nút con mắt: nhấn giữ thì hiện mật khẩu đã nhập, thả ra thì ẩn lại.
  const password = page.getByLabel("Mật khẩu");
  const eye = page.getByRole("button", { name: "Nhấn giữ để xem nội dung đã nhập" });
  await password.fill("BiMat12345");
  await expect(password).toHaveAttribute("type", "password");
  await eye.dispatchEvent("pointerdown");
  await expect(password).toHaveAttribute("type", "text");
  await expect(password).toHaveValue("BiMat12345");
  await page.screenshot({ path: "test-results/shots/password-reveal-360.png" });
  await eye.dispatchEvent("pointerup");
  await expect(password).toHaveAttribute("type", "password");
  await eye.focus();
  await page.keyboard.down("Space");
  await expect(password).toHaveAttribute("type", "text");
  await page.keyboard.up("Space");
  await expect(password).toHaveAttribute("type", "password");
});

test("GV: buộc đổi mật khẩu, chỉ thấy lớp mình và học viên lớp mình (không có thông tin cá nhân), không vào được dữ liệu lớp khác hay trang Admin", async ({ page }) => {
  await firstLogin(page, "gv.lan");
  await expect(page).toHaveURL(/\/teacher\/dashboard$/);
  await expect(page.getByText("RB-CB01").first()).toBeVisible();
  await expect(page.getByText("RB-NC01")).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  const db = sql();
  const [own] = await db`select id from classes where code = 'RB-CB01'`;
  const [other] = await db`select id from classes where code = 'RB-NC01'`;
  await db.end();

  await page.goto(`/teacher/classes/${own!.id}`);
  await expect(page.getByRole("heading", { name: /RB-CB01/ })).toBeVisible();
  await page.screenshot({ path: "test-results/shots/teacher-class-360.png" });
  await expect(page.getByText("Lê Gia Bảo")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Gọi trực tiếp bằng id lớp của GV khác → 404, không lộ dữ liệu.
  await expectNotFound(page, `/teacher/classes/${other!.id}`);
  await expect(page.getByText("Robotics Nâng cao")).toHaveCount(0);

  // QL Học viên: GV xem được học viên lớp mình để theo dõi tiến độ; không có thông tin cá nhân, không có nút Thêm/Sửa/Xóa.
  await page.goto("/admin/students");
  await expect(page).toHaveURL(/\/admin\/students$/);
  await expect(page.getByRole("heading", { name: /Học viên/ })).toContainText("(8)");
  await expect(visibleText(page, "Lê Gia Bảo")).toBeVisible();
  await expect(page.getByText(/Phụ huynh|Điện thoại|Ngày sinh|09020000/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Thêm" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Sửa|Xóa) / })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/teacher-students-360.png" });
  // Hồ sơ của học viên lớp mình mở được; học viên lớp khác coi như không tồn tại.
  await page.getByRole("link", { name: "Hồ sơ" }).first().click();
  await expect(page.getByRole("heading", { name: /^Chương trình học/ })).toBeVisible();
  const outsider = sql();
  const [foreign] = await outsider`
    select s.id from students s join enrollments e on e.student_id = s.id join classes c on c.id = e.class_id
    where c.code = 'RB-NC01' and s.id not in (select student_id from enrollments e2 join classes c2 on c2.id = e2.class_id where c2.code = 'RB-CB01') limit 1`;
  await outsider.end();
  await expectNotFound(page, `/admin/students/${foreign!.id}`);

  // Trang Admin khác: bị đưa về trang của GV.
  await page.goto(`/admin/classes/${other!.id}`);
  await expect(page).toHaveURL(/\/teacher\/dashboard$/);
  await page.goto("/admin/enrollments");
  await expect(page).toHaveURL(/\/teacher\/dashboard$/);

  // Gọi thẳng API ngoài quyền (kèm cookie phiên của GV) → 403.
  expect((await page.request.get("/api/export/unpaid-tuition?format=xlsx")).status()).toBe(403);
  // Syllabus thì giáo viên tự soạn cho lớp mình: tải được tệp mẫu; tệp không phải Excel bị từ chối vì nội dung, không phải vì quyền.
  const template = await page.request.get("/api/import/syllabus");
  expect(template.status()).toBe(200);
  const upload = await page.request.post("/api/import/syllabus?mode=commit", {
    headers: { origin: new URL(page.url()).origin },
    multipart: { file: { name: "a.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("PK\u0003\u0004") } },
  });
  expect(upload.status()).toBe(400);
});

test("API ghi dữ liệu từ chối yêu cầu khác nguồn (CSRF) và yêu cầu chưa đăng nhập", async ({ request }) => {
  const anonymous = await request.get("/api/import/syllabus");
  expect(anonymous.status()).toBe(401);
  const crossSite = await request.post("/api/import/syllabus", {
    headers: { origin: "https://evil.example" },
    multipart: { file: { name: "a.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("x") } },
  });
  expect(crossSite.status()).toBe(403);
});

let adminSecret = "";

test("Admin: đổi mật khẩu → bắt buộc thiết lập 2FA → quản lý học viên trên màn hình 360px", async ({ page }) => {
  await firstLogin(page, "admin");
  await expect(page).toHaveURL(/\/two-factor\/setup$/);

  // Chưa bật 2FA thì không vào được trang quản trị.
  await page.goto("/admin/students");
  await expect(page).toHaveURL(/\/two-factor\/setup$/);

  await page.getByLabel("Nhập lại mật khẩu để tiếp tục").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Tiếp tục" }).click();
  adminSecret = (await page.getByTestId("totp-secret").innerText()).trim();
  expect(adminSecret.length).toBeGreaterThan(10);
  saveAdminSecret(adminSecret);
  await page.screenshot({ path: "test-results/shots/2fa-setup-360.png", fullPage: true });
  await expectNoHorizontalScroll(page);
  await page.getByLabel(/Nhập mã 6 số/).fill(totp(adminSecret));
  await page.getByRole("button", { name: "Hoàn tất" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
  await expectNoHorizontalScroll(page);

  await page.goto("/admin/students");
  await expect(visibleText(page, "Lê Gia Bảo")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/admin-students-360.png" });

  // Phân trang: mỗi trang 10 học viên có STT; trang 2 đánh số tiếp từ 11.
  const cards = page.locator("ul:visible > li");
  await expect(cards).toHaveCount(10);
  await expect(cards.first()).toContainText("1.");
  await expect(page.getByText("Trang 1/2 · 15 học viên")).toBeVisible();
  await page.getByRole("link", { name: "Sau ›" }).click();
  await expect(page).toHaveURL(/\/admin\/students\?page=2$/);
  await expect(cards).toHaveCount(5);
  await expect(cards.first()).toContainText("11.");
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/admin-students-page2-360.png", fullPage: true });
  await page.getByRole("link", { name: "‹ Trước" }).click();
  await expect(page).toHaveURL(/\/admin\/students$/);

  // QL Học viên chỉ để xem và sửa: không còn nút Thêm và Nhập từ Excel; trang và API nhập Excel học viên đã gỡ.
  await expect(page.getByRole("button", { name: "Thêm" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Nhập từ Excel" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Sửa / }).first()).toBeVisible();
  await expectNotFound(page, "/admin/students/import");
  expect((await page.request.get("/api/import/students")).status()).toBe(404);

  // Học viên chưa có lớp nhập ở mục Chờ lớp của Ghi danh (không còn nút "Thêm học viên mới" đầu trang); form không có ô Mã HV.
  // Lỗi xác thực hiển thị theo trường, sau đó lưu thành công và em nằm trong danh sách chờ với mã tự cấp.
  await page.goto("/admin/enrollments");
  await expect(page.getByRole("button", { name: "Thêm học viên mới" })).toHaveCount(0);
  await page.getByRole("button", { name: "Thêm vào danh sách chờ" }).click();
  await expect(page.getByLabel("Mã HV")).toHaveCount(0);
  await page.locator("#f-schoolGrade").fill("13");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Bắt buộc nhập")).toBeVisible();
  await page.screenshot({ path: "test-results/shots/student-form-error-360.png" });
  await page.locator("#f-schoolGrade").fill("");
  await page.getByLabel("Họ tên").fill("Trần Thử Nghiệm <script>alert(1)</script>");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã thêm vào danh sách chờ.")).toBeVisible();
  // Nội dung người dùng nhập hiển thị dạng văn bản, không chạy như HTML: ở mục Chờ lớp và ở QL Học viên.
  const waitingRow = page.locator("[data-waiting]").filter({ hasText: "Trần Thử Nghiệm <script>alert(1)</script>" });
  await expect(waitingRow).toHaveAttribute("data-waiting", /^HX\d{4,}$/);
  await page.goto(`/admin/students?q=${encodeURIComponent("Trần Thử Nghiệm")}`);
  await expect(visibleText(page, "Trần Thử Nghiệm <script>alert(1)</script>")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Thêm một học viên nữa kèm thông tin cá nhân, chưa xếp lớp.
  await page.goto("/admin/enrollments");
  await page.getByRole("button", { name: "Thêm vào danh sách chờ" }).click();
  await page.getByLabel("Họ tên").fill("Đinh Nhập Excel");
  await page.locator("#f-schoolGrade").fill("4");
  await page.locator("#f-phone").fill("0903334445");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã thêm vào danh sách chờ.")).toBeVisible();
  await page.goto(`/admin/students?q=${encodeURIComponent("Đinh Nhập Excel")}`);
  await expect(visibleText(page, "Đinh Nhập Excel")).toBeVisible();
  await expect(visibleText(page, "0903334445")).toBeVisible();

  // Các trang quản trị còn lại hiển thị được và không tràn ngang ở 360px.
  for (const [path, heading] of [
    ["/admin/teachers", "Giáo viên"],
    ["/admin/courses", "Khóa học"],
    ["/admin/rooms-slots", "Phòng học"],
    ["/admin/enrollments", "Ghi danh"],
    ["/admin/accounts", "Tài khoản"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
  await page.screenshot({ path: "test-results/shots/accounts-360.png", fullPage: true });

  // Ghi danh: chọn lớp, thêm học viên vừa nhập.
  await page.goto("/admin/enrollments");
  // Chọn lớp là hiện danh sách ngay, không còn nút "Xem".
  await expect(page.getByRole("button", { name: "Xem", exact: true })).toHaveCount(0);
  await page.getByLabel("Lớp học").selectOption({ label: "RB-NC01 – Robotics Nâng cao 01 (7/8)" });
  await expect(page).toHaveURL(/\/admin\/enrollments\?classId=/);
  await page.getByRole("button", { name: "Ghi danh học viên" }).click();
  const newcomer = await page.locator("#f-studentId option").filter({ hasText: "Đinh Nhập Excel" }).getAttribute("value");
  await page.getByLabel("Học viên").selectOption(newcomer!);
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã ghi danh.")).toBeVisible();
  await expect(page.getByText("Đinh Nhập Excel")).toBeVisible();
  // Lớp đã đủ 8/8: ghi danh thêm bị chặn ở máy chủ.
  await page.getByRole("button", { name: "Ghi danh học viên" }).click();
  await page.getByLabel("Học viên").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Lớp đã đủ sĩ số tối đa (8).")).toBeVisible();
  await page.screenshot({ path: "test-results/shots/enroll-full-360.png" });
  await page.getByRole("button", { name: "Hủy" }).click();

  // Menu di động.
  await page.getByRole("button", { name: "Mở menu" }).click();
  await page.getByRole("link", { name: "Lớp học" }).click();
  await expect(page).toHaveURL(/\/admin\/classes$/);
  await expect(visibleText(page, "RB-CB01 – Robotics Cơ bản 01")).toBeVisible();
  await page.screenshot({ path: "test-results/shots/admin-classes-360.png" });
  await expectNoHorizontalScroll(page);
});

test("Admin đăng nhập lại phải nhập mã TOTP; mã sai bị từ chối", async ({ page }) => {
  await login(page, "admin", NEW_PASSWORD);
  await expect(page).toHaveURL(/\/two-factor$/);
  // Chỉ có mật khẩu thì chưa có phiên.
  await page.goto("/admin/dashboard");
  await expect(page).toHaveURL(/\/login$/);

  await login(page, "admin", NEW_PASSWORD);
  await expect(page).toHaveURL(/\/two-factor$/);
  await page.getByLabel("Mã xác thực").fill("000000");
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page.locator('[data-slot="alert"]')).toBeVisible();
  await page.getByLabel("Mã xác thực").fill(totp(adminSecret));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);
});

test("sai mật khẩu nhiều lần thì tài khoản bị khóa tạm, kể cả khi nhập đúng sau đó", async ({ page }) => {
  for (let i = 0; i < 5; i++) {
    await login(page, "gv.minh", "SaiMatKhau000");
    await expect(page.locator('[data-slot="alert"]')).toBeVisible();
  }
  await login(page, "gv.minh", SEED_PASSWORD);
  await expect(page.locator('[data-slot="alert"]')).toContainText("tạm khóa");
  await expect(page).toHaveURL(/\/login$/);

  const db = sql();
  const actions = await db`select action from audit_logs where action like 'login_%' order by created_at`;
  await db.end();
  expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(["login_failed", "login_failed_locked", "login_blocked_locked"]));
});
