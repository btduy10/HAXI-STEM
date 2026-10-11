import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { NEW_PASSWORD, expectNoHorizontalScroll, expectNotFound, loadAdminSecret, login, sql, totp } from "./helpers";

// Chạy sau phase1–3. Đóng lớp RB-NC01 (lớp của gv.minh) để không ảnh hưởng dữ liệu lớp RB-CB01.
test.describe.configure({ mode: "serial" });

let ownClassId = "";
let otherClassId = "";

test.beforeAll(async () => {
  const db = sql();
  const rows = await db`select id, code from classes where code in ('RB-CB01', 'RB-NC01')`;
  ownClassId = rows.find((r) => r.code === "RB-CB01")!.id;
  otherClassId = rows.find((r) => r.code === "RB-NC01")!.id;
  await db.end();
  mkdirSync("test-results/exports", { recursive: true });
});

test("GV: không còn Báo cáo lớp; không xuất được tổng kết hay báo cáo tài chính; TKB xuất ra chỉ của mình", async ({ page }) => {
  await login(page, "gv.lan", NEW_PASSWORD);
  await expect(page).toHaveURL(/\/teacher\/dashboard$/);
  // Báo cáo lớp đã bỏ: trang lớp không còn nút, đường dẫn cũ và API xuất cũ không còn.
  await page.goto(`/teacher/classes/${ownClassId}`);
  await expect(page.getByRole("heading", { name: /RB-CB01/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Báo cáo lớp" })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  expect((await page.request.get(`/api/export/class-report/${ownClassId}?format=xlsx`)).status()).toBe(404);
  await expectNotFound(page, `/teacher/classes/${ownClassId}/report`);

  // Gọi trực tiếp API xuất bằng phiên của GV.
  expect((await page.request.get(`/api/export/summary/${ownClassId}?format=xlsx`)).status()).toBe(403);
  expect((await page.request.get("/api/export/unpaid-tuition?format=xlsx")).status()).toBe(403);
  expect((await page.request.get("/api/export/timetable?format=exe")).status()).toBe(400);

  // TKB xuất ra chỉ gồm lịch của mình dù truyền classId của lớp khác.
  const timetable = await page.request.get(`/api/export/timetable?format=pdf&classId=${otherClassId}`);
  expect(timetable.status()).toBe(200);
  expect((await timetable.body()).subarray(0, 5).toString()).toBe("%PDF-");
  for (const path of ["/admin/rewards", "/admin/reports", "/admin/audit", "/admin/settings"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/teacher\/dashboard$/);
  }
});

test("Admin: cấu hình, đóng lớp, chốt tổng kết, duyệt và trao quà, xuất danh sách, nhật ký", async ({ page }) => {
  await login(page, "admin", NEW_PASSWORD);
  await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);

  // Cấu hình.
  await page.goto("/admin/settings");
  await page.getByRole("button", { name: "Sửa cấu hình" }).click();
  await page.getByLabel("Khóa sửa điểm danh sau (ngày)").fill("10");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("10 ngày")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Kho quà và mốc quà có sẵn từ dữ liệu mẫu.
  await page.goto("/admin/rewards?tab=gifts");
  await expect(page.getByText("Sticker robot").filter({ visible: true }).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.goto("/admin/rewards?tab=tiers");
  // Mốc quà đặt theo lớp (lớp không gắn với khóa học); form không còn ô "Áp dụng cho khóa học".
  await expect(page.getByText("RB-NC01 – Robotics Nâng cao 01").filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(/^Khóa /)).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // Tổng kết: lớp đang mở, còn buổi hôm nay chưa điểm danh → không đóng được.
  await page.goto("/admin/rewards?tab=summary");
  await page.getByLabel("Lớp học").selectOption({ label: "RB-NC01 – Robotics Nâng cao 01 (Đang mở)" });
  await expect(page).toHaveURL(/tab=summary&classId=/);
  await expect(page.getByRole("heading", { name: "Số liệu tạm tính (lớp đang mở)" })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Đóng lớp & chốt tổng kết" }).click();
  await expect(page.getByText(/buổi đã qua chưa điểm danh/)).toBeVisible();

  // Xử lý các buổi đã qua chưa điểm danh (hủy), rồi đóng lớp.
  const db = sql();
  await db`
    update sessions set status = 'cancelled'
    where class_id = ${otherClassId} and status = 'planned'
      and date <= (now() at time zone 'Asia/Ho_Chi_Minh')::date`;
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Đóng lớp & chốt tổng kết" }).click();
  await expect(page.getByText("Đã đóng lớp và chốt tổng kết.")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Tổng kết đã chốt/ })).toBeVisible();
  await expect(page.getByText(/Hệ thống đề xuất \d+ học viên đủ điều kiện nhận quà/)).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/summary-proposal-360.png", fullPage: true });

  // Duyệt tất cả đề xuất rồi ghi nhận trao một quà.
  await page.getByRole("button", { name: /^Duyệt \d+ học viên$/ }).click();
  await expect(page.getByText(/Đã duyệt quà cho \d+ học viên\./)).toBeVisible();
  await page.getByRole("button", { name: /^Ghi nhận đã trao quà cho / }).first().click();
  await expect(page.getByText(/Đã ghi nhận trao quà cho /)).toBeVisible();
  await expect(page.getByText(/Trao lúc .* bởi Quản trị viên/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Số lượng quà cần chuẩn bị" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/summary-approved-360.png", fullPage: true });

  const [counts] = await db`
    select count(*) filter (where h.status = 'given')::int as given, count(*)::int as total,
           (select count(*)::int from sessions where class_id = ${otherClassId} and status = 'planned') as planned,
           (select status from classes where id = ${otherClassId}) as status
    from gift_handovers h join course_summaries s on s.id = h.summary_id where s.class_id = ${otherClassId}`;
  await db.end();
  expect(counts).toMatchObject({ given: 1, planned: 0, status: "closed" });
  expect(counts!.total).toBeGreaterThanOrEqual(1);

  // Xuất danh sách tổng kết (để in) và TKB.
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "PDF" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("tong-ket-RB-NC01.pdf");
  await file.saveAs("test-results/exports/tong-ket.pdf");
  const xlsx = await page.request.get(`/api/export/summary/${otherClassId}?format=xlsx`);
  expect(xlsx.status()).toBe(200);
  const timetable = await page.request.get("/api/export/timetable?format=pdf");
  writeFileSync("test-results/exports/tkb.pdf", await timetable.body());
  expect((await page.request.get("/api/export/timetable?format=xlsx&from=2026-01-01&to=2027-01-01")).status()).toBe(400);

  // Báo cáo tài chính trên màn hình rộng (chi tiết luồng ở phase5).
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/admin/reports");
  await expect(page.getByRole("heading", { name: "Doanh thu theo tháng" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Tổng chi" })).toBeVisible();
  await page.screenshot({ path: "test-results/shots/report-1280.png", fullPage: true });
  await page.goto(`/admin/rewards?tab=summary&classId=${otherClassId}`);
  await page.screenshot({ path: "test-results/shots/summary-1280.png", fullPage: true });
  await page.goto("/admin/dashboard");
  await expect(page.getByRole("heading", { name: "Điểm danh 30 ngày qua" })).toBeVisible();
  await expect(page.getByRole("img", { name: /có đi học: \d+%/ })).toBeVisible();
  await page.screenshot({ path: "test-results/shots/dashboard-1280.png", fullPage: true });

  // Chấm công: mở từ menu, chọn lớp là tính theo trọn khóa của lớp; chọn giáo viên là lọc ngay.
  await page.getByRole("link", { name: "Chấm công" }).click();
  await expect(page.getByRole("heading", { name: "Chấm công giáo viên" })).toBeVisible();
  await page.getByLabel("Lớp (tính theo khóa)").selectOption({ label: "RB-NC01 – Robotics Nâng cao 01" });
  await expect(page).toHaveURL(/classId=/);
  await expect(page.getByRole("link", { name: "Cả khóa của lớp RB-NC01" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Số buổi" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Thành tiền" }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: /Chi tiết buổi dạy/ })).toBeVisible();
  await page.getByLabel("Giáo viên").selectOption({ label: "GV01 – Nguyễn Thị Lan" });
  await expect(page).toHaveURL(/teacherId=/);
  await page.getByLabel("Giáo viên").selectOption({ label: "Tất cả giáo viên" });
  await page.screenshot({ path: "test-results/shots/timesheet-1280.png", fullPage: true });
  await page.setViewportSize({ width: 360, height: 740 });
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/timesheet-360.png", fullPage: true });
  await page.goto("/admin/dashboard");

  // Biểu đồ trên điện thoại: không tràn ngang, có chú giải số liệu.
  await expect(page.getByRole("heading", { name: "Chuyên cần theo lớp" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Vắng không phép" }).first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/dashboard-360.png", fullPage: true });
  await page.goto("/admin/reports");
  await expect(page.getByRole("heading", { name: "Doanh thu theo tháng" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/report-charts-360.png", fullPage: true });

  // Sửa tài khoản: đổi tên hiển thị của một GV; trùng tên đăng nhập bị từ chối.
  await page.goto("/admin/accounts");
  const lan = page.getByRole("listitem").filter({ hasText: "gv.lan" });
  await lan.getByRole("button", { name: "Sửa" }).click();
  await page.getByLabel("Tên đăng nhập").fill("gv.minh");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByRole("dialog").getByText("Tên đăng nhập đã tồn tại").first()).toBeVisible();
  await page.getByLabel("Tên đăng nhập").fill("gv.lan");
  await page.getByLabel("Tên hiển thị").fill("Cô Lan Robotics");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã cập nhật tài khoản.")).toBeVisible();
  await expect(lan).toContainText("Cô Lan Robotics");

  // Sửa tài khoản không làm tài khoản bị khóa. Admin khóa tay rồi mở khóa lại được; không có nút khóa chính mình.
  await expect(lan.getByText("Đang khóa")).toHaveCount(0);
  page.on("dialog", (dialog) => void dialog.accept());
  await lan.getByRole("button", { name: "Khóa", exact: true }).click();
  await expect(page.getByText("Đã khóa tài khoản.")).toBeVisible();
  await expect(lan.getByText("Đang khóa")).toBeVisible();
  await lan.getByRole("button", { name: "Mở khóa", exact: true }).click();
  await expect(page.getByText("Đã mở khóa tài khoản.")).toBeVisible();
  await expect(lan.getByText("Đang khóa")).toHaveCount(0);
  const self = page.getByRole("listitem").filter({ hasText: "Quản trị" }).first();
  await expect(self.getByRole("button", { name: /khóa/i })).toHaveCount(0);

  // Tạo một tài khoản rồi xóa hẳn; không có nút xóa chính mình.
  await page.getByRole("button", { name: "Thêm tài khoản" }).click();
  await page.locator("#f-username").fill("tam.thoi");
  await page.locator("#f-name").fill("Tài khoản tạm");
  await page.locator("#f-role").selectOption("admin");
  await page.locator("#f-password").fill("MatKhauTam88");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã tạo tài khoản.")).toBeVisible();
  const temp = page.getByRole("listitem").filter({ hasText: "tam.thoi" });
  await temp.getByRole("button", { name: "Xóa", exact: true }).click();
  await expect(page.getByText("Đã xóa tài khoản.")).toBeVisible();
  await expect(temp).toHaveCount(0);
  await expect(self.getByRole("button", { name: "Xóa", exact: true })).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // Đặt lại mật khẩu có nút con mắt và lựa chọn dùng luôn.
  const minh = page.getByRole("listitem").filter({ hasText: "gv.minh" });
  await minh.getByRole("button", { name: "Đặt lại mật khẩu" }).click();
  await page.locator("#f-password").fill("MatKhauDatLai8");
  await page.getByRole("dialog").getByRole("button", { name: "Nhấn giữ để xem nội dung đã nhập" }).dispatchEvent("pointerdown");
  await expect(page.locator("#f-password")).toHaveAttribute("type", "text");
  await page.getByRole("dialog").getByRole("button", { name: "Nhấn giữ để xem nội dung đã nhập" }).dispatchEvent("pointerup");
  await page.locator("#f-mustChange").selectOption({ label: "Dùng luôn mật khẩu này" });
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã đặt lại mật khẩu.")).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Gửi tài khoản qua email: chỉ tài khoản gắn giáo viên có nút; hộp thoại ghi địa chỉ nhận lấy từ menu Giáo viên.
  // Máy chủ test không khai báo SMTP nên báo lỗi và không đổi mật khẩu (test sau vẫn đăng nhập bằng mật khẩu vừa đặt lại).
  await expect(self.getByRole("button", { name: "Gửi tài khoản" })).toHaveCount(0);
  await minh.getByRole("button", { name: "Gửi tài khoản" }).click();
  await expect(page.getByRole("dialog")).toContainText("minh@haxi.example");
  await page.locator("#f-password").fill("MatKhauGui2026");
  await page.getByRole("dialog").getByRole("button", { name: "Gửi", exact: true }).click();
  await expect(page.getByRole("dialog").getByText(/Chưa cấu hình gửi email/)).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.screenshot({ path: "test-results/shots/accounts-edit-360.png", fullPage: true });

  // Nhật ký: lọc theo hành động, xem chi tiết.
  await page.goto("/admin/audit");
  await expect(page.getByRole("heading", { name: "Nhật ký" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.getByLabel("Lọc theo hành động").fill("class_closed");
  await page.getByRole("button", { name: "Lọc" }).click();
  await expect(page.getByText("class_closed")).toHaveCount(1);
  await page.getByText("Chi tiết").click();
  await expect(page.getByText(/"summaries": \d+/)).toBeVisible();
  await page.getByLabel("Lọc theo hành động").fill("export");
  await page.getByRole("button", { name: "Lọc" }).click();
  await expect(page.getByText("export").first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/audit-360.png" });
});

test("GV của lớp đã đóng: thấy lớp ở trạng thái đã đóng, không điểm danh hay ghi sao được nữa", async ({ page }) => {
  // gv.minh bị khóa tạm ở phase1 (sai mật khẩu 5 lần). Ở test trước, Admin đã đặt lại mật khẩu với lựa chọn
  // "Dùng luôn mật khẩu này": việc đó phải gỡ khóa và cho đăng nhập thẳng, không bắt đổi mật khẩu.
  const db = sql();
  const [session] = await db`select id from sessions where class_id = ${otherClassId} and status = 'done' order by date desc limit 1`;
  await db.end();

  await login(page, "gv.minh", "MatKhauDatLai8");
  await expect(page).toHaveURL(/\/teacher\/dashboard$/);

  await page.goto("/teacher/classes");
  await expect(page.getByText("Đã đóng")).toBeVisible();
  await page.goto(`/teacher/sessions/${session!.id}/stars`);
  await page.getByRole("button", { name: "Chọn cả lớp" }).click();
  await page.getByRole("button", { name: "Ghi sao", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: /Hoàn thành nhiệm vụ/ }).click();
  await expect(page.getByText(/Lớp đã đóng và đã chốt tổng kết/)).toBeVisible();
});

test("Phân quyền: ô tick thông tin cá nhân học viên; Giáo viên trực xem và sửa học viên, chỉ làm được đúng phần được mở", async ({ page, context }) => {
  await login(page, "admin", NEW_PASSWORD);
  await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);

  // Cấu hình → Phân quyền. Tick Sửa thì tự tick Xem; bỏ Xem thì bỏ hết.
  await page.goto("/admin/settings");
  await expect(page.getByRole("heading", { name: "Phân quyền" })).toBeVisible();
  const box = (name: string) => page.getByRole("checkbox", { name, exact: true });
  // Một bảng duy nhất: chọn vai trò ở ô "Vai trò"; danh sách người mang vai trò lấy từ Tài khoản.
  const roleSelect = page.getByLabel("Vai trò", { exact: true });
  await expect(roleSelect.locator("option")).toHaveText(["Giáo viên (2 tài khoản)", "Giáo viên trực (0 tài khoản)"]);
  await expect(page.getByText(/Tài khoản mang vai trò này: .*gv\.lan .*gv\.minh \(Trần Văn Minh\)/)).toBeVisible();
  await expect(box("Giáo viên: Thêm Sao")).toBeChecked();
  // Mặc định: Giáo viên xem QL Học viên (không sửa), không có thông tin cá nhân; menu này không còn cột Thêm.
  await expect(box("Giáo viên: Xem QL Học viên")).toBeChecked();
  await expect(box("Giáo viên: Sửa QL Học viên")).not.toBeChecked();
  await expect(box("Giáo viên: Thêm QL Học viên")).toHaveCount(0);
  await expect(box("Giáo viên: Thông tin cá nhân học viên")).not.toBeChecked();
  await expect(box("Giáo viên trực: Xem Điểm danh")).toHaveCount(0);
  await roleSelect.selectOption("duty_teacher");
  await expect(page.getByText("Chưa có tài khoản nào mang vai trò này.")).toBeVisible();
  await expect(box("Giáo viên trực: Xem Điểm danh")).toBeChecked();
  await box("Giáo viên trực: Sửa Khóa học").check();
  await expect(box("Giáo viên trực: Xem Khóa học")).toBeChecked();
  await box("Giáo viên trực: Xem Khóa học").uncheck();
  await expect(box("Giáo viên trực: Sửa Khóa học")).not.toBeChecked();
  // Mặc định: Giáo viên trực xem + sửa QL Học viên và có thông tin cá nhân.
  await expect(box("Giáo viên trực: Xem QL Học viên")).toBeChecked();
  await expect(box("Giáo viên trực: Sửa QL Học viên")).toBeChecked();
  await expect(box("Giáo viên trực: Thông tin cá nhân học viên")).toBeChecked();
  await box("Giáo viên trực: Xem Khóa học").check();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/permissions-360.png", fullPage: true });
  await page.getByRole("button", { name: "Lưu phân quyền" }).click();
  await expect(page.getByText("Đã lưu phân quyền.")).toBeVisible();

  // Menu Giáo viên không còn cột Vai trò: vai trò chỉ gán ở Tài khoản.
  await page.goto("/admin/teachers");
  await expect(page.locator("ul:visible > li").first()).toContainText("Họ tên:");
  await expect(page.getByText("Vai trò", { exact: false })).toHaveCount(0);
  await page.getByRole("button", { name: "Sửa Trần Văn Minh" }).click();
  await expect(page.locator("#f-role")).toHaveCount(0);
  await page.getByRole("button", { name: "Hủy" }).click();
  await expectNoHorizontalScroll(page);
  // Đổi tài khoản gv.minh (gắn với GV02) sang Giáo viên trực ở Tài khoản thì bảng phân quyền đếm theo.
  await page.goto("/admin/accounts");
  await page.getByRole("listitem").filter({ hasText: "gv.minh" }).getByRole("button", { name: "Sửa", exact: true }).click();
  await page.locator("#f-role").selectOption({ label: "Giáo viên trực" });
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã cập nhật tài khoản.")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.goto("/admin/settings");
  await expect(page.getByLabel("Vai trò", { exact: true }).locator("option")).toHaveText(["Giáo viên (1 tài khoản)", "Giáo viên trực (1 tài khoản)"]);

  // Tạo vai trò mới "Lễ tân": đổi tên, tick Xem Ghi danh, lưu. Vai trò mới có ngay trong ô chọn khi tạo tài khoản.
  await page.getByRole("button", { name: "Thêm vai trò" }).click();
  await expect(page.getByLabel("Tên vai trò")).toHaveValue("Vai trò mới");
  await page.getByLabel("Tên vai trò").fill("Lễ tân");
  await box("Lễ tân: Thêm Ghi danh").check();
  await expect(box("Lễ tân: Xem Ghi danh")).toBeChecked();
  await expect(page.getByRole("button", { name: "Xóa vai trò" })).toBeEnabled();
  await page.getByRole("button", { name: "Lưu phân quyền" }).click();
  await expect(page.getByText("Đã lưu phân quyền.")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/roles-360.png", fullPage: true });

  await page.goto("/admin/accounts");
  await expect(page.getByRole("listitem").filter({ hasText: "gv.minh" }).getByText("Giáo viên trực", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Thêm tài khoản" }).click();
  await page.locator("#f-username").fill("le.tan");
  await page.locator("#f-name").fill("Lễ tân trung tâm");
  await page.locator("#f-role").selectOption({ label: "Lễ tân" });
  await page.locator("#f-password").fill("MatKhauTam88");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã tạo tài khoản.")).toBeVisible();
  // Lọc theo vai trò: chỉ còn tài khoản Lễ tân. Vai trò đang có người dùng thì không xóa được.
  await page.getByLabel("Lọc theo vai trò").selectOption({ label: "Lễ tân" });
  await expect(page).toHaveURL(/role=role_/);
  await expect(page.locator("ul:visible > li")).toHaveCount(1);
  await expect(page.locator("ul:visible > li")).toContainText("le.tan");
  await expectNoHorizontalScroll(page);
  await page.goto("/admin/settings");
  await page.getByLabel("Vai trò", { exact: true }).selectOption({ label: "Lễ tân (1 tài khoản)" });
  await expect(page.getByRole("button", { name: "Xóa vai trò" })).toBeDisabled();
  // Bảng tài khoản trên màn hình rộng.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/admin/accounts");
  await expect(page.getByRole("columnheader", { name: "Đăng nhập gần nhất" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "le.tan" }).getByText("Lễ tân", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/shots/accounts-table-1280.png", fullPage: true });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/admin/accounts");

  // Tạo tài khoản Giáo viên trực (không cần gắn với hồ sơ giáo viên).
  await page.getByRole("button", { name: "Thêm tài khoản" }).click();
  await page.locator("#f-username").fill("truc.ban");
  await page.locator("#f-name").fill("Trực ban");
  await page.locator("#f-role").selectOption({ label: "Giáo viên trực" });
  await page.locator("#f-password").fill("MatKhauTam88");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã tạo tài khoản.")).toBeVisible();

  // Đăng nhập bằng tài khoản Giáo viên trực.
  await context.clearCookies();
  await login(page, "truc.ban", "MatKhauTam88");
  await expect(page).toHaveURL(/\/change-password$/);
  await page.getByLabel("Mật khẩu hiện tại").fill("MatKhauTam88");
  await page.getByLabel("Mật khẩu mới", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Nhập lại mật khẩu mới").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Lưu mật khẩu" }).click();
  await expect(page).toHaveURL(/\/teacher\/dashboard$/);

  // Menu: khu vực giảng dạy (thấy mọi lớp) + các menu được tick Xem; không có menu quản trị.
  // Khung trang hiện trước khi nút kịp gắn sự kiện nên bấm lại cho tới khi menu mở.
  const menu = page.getByRole("dialog");
  await expect(async () => {
    await page.getByRole("button", { name: "Mở menu" }).click();
    await expect(menu).toBeVisible({ timeout: 1000 });
  }).toPass();
  for (const name of ["Tổng quan", "Thời khóa biểu", "Lớp học", "QL Học viên", "Điểm danh"]) {
    await expect(menu.getByRole("link", { name, exact: true })).toBeVisible();
  }
  for (const name of ["Tài khoản", "Cấu hình", "Nhật ký", "Giáo viên", "Chấm công"]) {
    await expect(menu.getByRole("link", { name, exact: true })).toHaveCount(0);
  }
  await page.screenshot({ path: "test-results/shots/duty-menu-360.png" });
  await menu.getByRole("link", { name: "Lớp học", exact: true }).click();
  await expect(page).toHaveURL(/\/teacher\/classes$/);
  await expect(page.getByText("RB-CB01").first()).toBeVisible();
  await expect(page.getByText("RB-NC01").first()).toBeVisible();

  // QL Học viên: xem mọi học viên kèm thông tin cá nhân và sửa được khi sai; không có nút thêm/xóa/nhập Excel.
  await page.goto("/admin/students");
  await expect(page.getByRole("heading", { name: /Học viên/ })).toBeVisible();
  await expect(page.locator("ul:visible > li")).toHaveCount(10);
  await expect(page.getByRole("button", { name: "Thêm" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Xóa / })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Nhập từ Excel" })).toHaveCount(0);
  await expect(page.getByText("Phụ huynh:").first()).toBeVisible();
  await page.getByRole("button", { name: "Sửa Lê Gia Bảo" }).click();
  await expect(page.locator("#f-guardianName")).toHaveValue("Phụ huynh Bảo");
  await page.locator("#f-phone").fill("0902000099");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã lưu.")).toBeVisible();
  await expect(page.getByText("0902000099").first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/duty-students-360.png" });

  // Điểm danh: thấy buổi của mọi lớp. Các menu không được mở và trang quản trị: bị đưa về trang chủ.
  await page.goto("/admin/attendance");
  await expect(page.getByRole("heading", { name: "Điểm danh", exact: true })).toBeVisible();
  for (const path of ["/admin/teachers", "/admin/timesheet", "/admin/accounts", "/admin/settings", "/admin/enrollments", "/admin/dashboard"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/teacher\/dashboard$/);
  }
  // Gọi thẳng API và Server Action ngoài quyền đều bị máy chủ từ chối.
  expect((await page.request.get("/api/import/syllabus")).status()).toBe(403);
  expect((await page.request.get(`/api/export/summary/${otherClassId}?format=xlsx`)).status()).toBe(403);
});