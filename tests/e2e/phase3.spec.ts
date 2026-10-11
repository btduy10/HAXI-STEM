import { type Page, expect, test } from "@playwright/test";
import { NEW_PASSWORD, expectNoHorizontalScroll, expectNotFound, loadAdminSecret, login, sql, totp } from "./helpers";

// Chạy sau phase1 + phase2: hôm nay mỗi lớp đã có một buổi học.
test.describe.configure({ mode: "serial" });

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const STUDENT = "Ngô Khánh Linh";

let sessionId = "";
let otherSessionId = "";
let studentId = "";
let otherStudentId = "";
let classId = "";

test.beforeAll(async () => {
  const db = sql();
  const [own] = await db`
    select s.id, s.class_id from sessions s join classes c on c.id = s.class_id
    where c.code = 'RB-CB01' and s.date = ${today()} and s.kind = 'regular' limit 1`;
  const [other] = await db`
    select s.id from sessions s join classes c on c.id = s.class_id where c.code = 'RB-NC01' and s.date = ${today()} limit 1`;
  const [student] = await db`select id from students where full_name = ${STUDENT}`;
  const [otherStudent] = await db`select id from students where code = 'HV015'`;
  sessionId = own!.id;
  classId = own!.class_id;
  otherSessionId = other!.id;
  studentId = student!.id;
  otherStudentId = otherStudent!.id;
  // Đưa tổng sao của học viên về đúng 19 để các con số trong kịch bản ổn định.
  const [{ total }] = (await db`select coalesce(sum(stars), 0)::int as total from star_logs where student_id = ${studentId}`) as unknown as [{ total: number }];
  if (total !== 19) await db`insert into star_logs (student_id, stars, note) values (${studentId}, ${19 - total}, 'Điều chỉnh cho kiểm thử')`;
  await db.end();
});

async function award(page: Page, names: string[] | "all", criteria: RegExp) {
  if (names === "all") await page.getByRole("button", { name: "Chọn cả lớp" }).click();
  else for (const name of names) await page.getByRole("checkbox", { name: `Chọn ${name}` }).click();
  await page.getByRole("button", { name: "Ghi sao", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: criteria }).click();
}

test("GV ghi sao trên điện thoại: một em, cả lớp, giới hạn trừ, hoàn tác; không còn avatar và cấp bậc", async ({ page }) => {
  await login(page, "gv.lan", NEW_PASSWORD);
  await expect(page).toHaveURL(/\/teacher\/dashboard$/);
  await page.goto(`/teacher/sessions/${sessionId}/attendance`);
  await page.getByRole("link", { name: "Ghi sao" }).click();
  await expect(page).toHaveURL(new RegExp(`/teacher/sessions/${sessionId}/stars$`));
  await expect(page.getByRole("checkbox")).toHaveCount(8);
  await expectNoHorizontalScroll(page);
  const row = page.getByRole("checkbox", { name: `Chọn ${STUDENT}` });
  // Mỗi em chỉ còn tên, mã và tổng sao: không có hình avatar, không có cấp.
  await expect(row).toContainText("19");
  await expect(row).not.toContainText("Cấp");
  await expect(page.getByRole("img", { name: /^Avatar / })).toHaveCount(0);

  // 19 + 1 = 20 sao: chỉ báo đã ghi sao, không còn thông báo lên cấp.
  await award(page, [STUDENT], /Phát biểu xây dựng bài/);
  await expect(page.getByText("Đã ghi +1 sao (Phát biểu xây dựng bài) cho 1 học viên.")).toBeVisible();
  await expect(row).toContainText("20");
  await expect(page.getByText(/Chúc mừng|lên cấp/)).toHaveCount(0);
  await page.screenshot({ path: "test-results/shots/stars-360.png", fullPage: true });

  // Hồ sơ học viên: còn sao, quà, chương trình, lịch sử; không còn mục Avatar, cấp và thanh tiến độ.
  await page.goto(`/teacher/students/${studentId}`);
  await expect(page.getByRole("heading", { name: new RegExp(STUDENT) })).toBeVisible();
  await expect(page.getByText("Tổng sao tích lũy")).toBeVisible();
  // Có mục Lịch học; không còn mục Lịch sử ghi sao và các nút xóa sao (sao hiện theo từng buổi ở Lịch sử buổi học).
  await expect(page.getByRole("heading", { name: /^Lịch học/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Lịch sử buổi học/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Lịch sử ghi sao/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Xóa hết" })).toHaveCount(0);
  // Xóa lịch sử học (từng dòng hoặc xóa hết) chỉ có ở hồ sơ do Admin mở.
  await expect(page.getByRole("button", { name: /^Xóa/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Avatar" })).toHaveCount(0);
  await expect(page.getByRole("img", { name: /^Avatar / })).toHaveCount(0);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.getByText(/Cấp \d/)).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/student-profile-360.png", fullPage: true });

  // 20 − 1 = 19: không còn thông báo tụt cấp.
  await page.goto(`/teacher/sessions/${sessionId}/stars`);
  await award(page, [STUDENT], /Mất trật tự/);
  await expect(page.getByText(/Đã ghi -1 sao/)).toBeVisible();
  await expect(row).toContainText("19");
  await expect(page.getByText(/tụt từ cấp|Avatar/)).toHaveCount(0);

  // Giới hạn trừ 3 sao/buổi: đã trừ 1, trừ thêm 2 được, trừ thêm 2 nữa bị chặn.
  await award(page, [STUDENT], /Không giữ gìn thiết bị/);
  await expect(page.getByText(/Đã ghi -2 sao/)).toBeVisible();
  await award(page, [STUDENT], /Không giữ gìn thiết bị/);
  await expect(page.getByText(/chỉ bị trừ tối đa 3 sao trong một buổi/)).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  // Hoàn tác lần trừ gần nhất: ghi bản đảo, bản gốc bị gạch.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: `Hoàn tác -2 sao của ${STUDENT}` }).click();
  await expect(page.getByText("Đã hoàn tác.")).toBeVisible();
  await expect(page.getByText("đã hoàn tác").first()).toBeVisible();

  // Ghi cho cả lớp.
  await page.getByRole("checkbox", { name: `Chọn ${STUDENT}` }).click(); // bỏ chọn em đang chọn dở
  await award(page, "all", /Hoàn thành nhiệm vụ/);
  await expect(page.getByText("Đã ghi +3 sao (Hoàn thành nhiệm vụ) cho 8 học viên.")).toBeVisible();

  const db = sql();
  const [{ total }] = (await db`select greatest(0, sum(stars))::int as total from star_logs where student_id = ${studentId}`) as unknown as [{ total: number }];
  await db.end();
  expect(total).toBe(19 + 1 - 1 - 2 + 2 + 3);

  // Danh sách lớp: mỗi em một thẻ tên kèm tổng sao, không có avatar, cấp hay thanh tiến độ.
  await page.goto(`/teacher/classes/${classId}`);
  await expect(page.getByRole("link", { name: new RegExp(STUDENT) })).toContainText("22");
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.getByRole("img", { name: /^Avatar / })).toHaveCount(0);
  await expect(page.getByText(/Cấp \d/)).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/class-stars-360.png", fullPage: true });
});

test("GV không ghi sao, không xem hồ sơ của học viên lớp khác; trang Sao chỉ đọc", async ({ page }) => {
  await login(page, "gv.lan", NEW_PASSWORD);
  await expect(page).toHaveURL(/\/teacher\/dashboard$/);
  await expectNotFound(page, `/teacher/sessions/${otherSessionId}/stars`);
  await expectNotFound(page, `/teacher/students/${otherStudentId}`);
  // GV xem được menu Sao nhưng chỉ đọc: không có nút thêm/sửa/xóa tiêu chí.
  await expectNotFound(page, `/admin/sessions/${otherSessionId}/stars`);
  await page.goto("/admin/stars?tab=criteria");
  await expect(page.getByRole("heading", { name: /Tiêu chí sao/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Thêm" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Sửa|Xóa) / })).toHaveCount(0);
  await page.goto("/admin/stars?tab=ledger");
  await expect(page.getByText("RB-NC01")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test("Admin: trang Sao chỉ còn Tiêu chí và Sổ cái; hồ sơ học viên không còn Avatar; menu Lớp học → Syllabus → Ghi danh → QL Học viên", async ({ page }) => {
  await login(page, "admin", NEW_PASSWORD);
  await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);

  // Thứ tự menu: Lớp học, Syllabus, Ghi danh, QL Học viên đứng liền nhau theo đúng thứ tự đó.
  const menu = page.getByRole("dialog");
  await expect(async () => {
    await page.getByRole("button", { name: "Mở menu" }).click();
    await expect(menu).toBeVisible({ timeout: 1000 });
  }).toPass();
  const labels = (await menu.getByRole("link").allTextContents()).map((label) => label.trim());
  const at = (name: string) => labels.indexOf(name);
  expect(at("Lớp học")).toBeGreaterThan(-1);
  expect([at("Syllabus") - at("Lớp học"), at("Ghi danh") - at("Syllabus"), at("QL Học viên") - at("Ghi danh")]).toEqual([1, 1, 1]);
  expect(labels.filter((label) => /avatar/i.test(label))).toEqual([]);
  await page.keyboard.press("Escape");

  await page.goto("/admin/stars");
  await expect(page.getByRole("heading", { name: "Sao", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Tiêu chí sao/ })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Mục" }).getByRole("link")).toHaveText(["Tiêu chí", "Sổ cái"]);
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/stars-admin-360.png", fullPage: true });
  // Địa chỉ của các tab đã bỏ quay về tab mặc định.
  for (const tab of ["levels", "avatars", "gifts"]) {
    await page.goto(`/admin/stars?tab=${tab}`);
    await expect(page.getByRole("heading", { name: /Tiêu chí sao/ })).toBeVisible();
  }
  // Hình avatar tĩnh không còn được phục vụ.
  expect((await page.request.get("/avatars/pico.svg")).status()).not.toBe(200);

  await page.goto(`/admin/students/${studentId}`);
  await expect(page.getByRole("heading", { name: new RegExp(STUDENT) })).toBeVisible();
  await expect(page.getByText("Tổng sao tích lũy")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Avatar" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Tặng avatar" })).toHaveCount(0);
  await expect(page.getByRole("img", { name: /^Avatar / })).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  await page.goto("/admin/stars?tab=ledger");
  await expect(page.getByText(/Sổ cái chỉ thêm/)).toBeVisible();
  await expect(page.getByText("Hoàn tác: Không giữ gìn thiết bị").first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/ledger-360.png" });
});
