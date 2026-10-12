import { expect, test } from "@playwright/test";
import { NEW_PASSWORD, expectNoHorizontalScroll, expectNotFound, loadAdminSecret, login, sql, totp, visibleText } from "./helpers";

// Chạy sau phase1 (thứ tự tên tệp): gv.lan đã đổi mật khẩu, admin đã bật 2FA.
test.describe.configure({ mode: "serial" });

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());

let ownSessionId = "";
let otherSessionId = "";

test.beforeAll(async () => {
  // Bảo đảm hôm nay mỗi lớp có một buổi (lịch mẫu của seed không rơi vào mọi ngày trong tuần).
  const db = sql();
  const date = today();
  for (const [code, start, end] of [
    ["RB-CB01", "07:00", "07:45"],
    ["RB-NC01", "06:00", "06:45"],
  ] as const) {
    const [cls] = await db`select c.id, c.default_room_id, ct.teacher_id from classes c join class_teachers ct on ct.class_id = c.id where c.code = ${code}`;
    const [row] = await db`
      insert into sessions (class_id, date, start_time, end_time, room_id, teacher_id)
      values (${cls!.id}, ${date}, ${start}, ${end}, ${cls!.default_room_id}, ${cls!.teacher_id}) returning id`;
    if (code === "RB-CB01") ownSessionId = row!.id;
    else otherSessionId = row!.id;
  }
  await db.end();
});

test("GV điểm danh trên điện thoại 360px: mặc định có mặt, sửa một em, lưu", async ({ page }) => {
  await login(page, "gv.lan", NEW_PASSWORD);
  await expect(page).toHaveURL(/\/teacher\/dashboard$/);
  // Tổng quan kiểu dashboard: KPI, phòng học hôm nay, danh sách có tab (lớp, giáo viên, học viên). Điện thoại không dựng cảnh 3D.
  await expect(page.getByRole("region", { name: "Phòng học hôm nay" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Lớp/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: /^Giáo viên/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Học viên/ })).toBeVisible();
  await expect(page.getByRole("list", { name: "Số liệu chính" }).filter({ visible: true })).toContainText("Buổi quá hạn chưa điểm danh");
  await expect(page.locator("canvas")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/teacher-dashboard-360.png", fullPage: true });

  // Bấm buổi hôm nay ở danh sách: thẻ chi tiết hiện lớp đó; "Mở buổi học" dẫn tới trang điểm danh của buổi.
  await page.getByRole("tabpanel").getByRole("button", { name: /07:00–07:45/ }).click();
  await page.locator("[data-detail-panel]").getByRole("link", { name: "Mở buổi học" }).click();
  await expect(page).toHaveURL(new RegExp(`/teacher/sessions/${ownSessionId}/attendance$`));
  await expect(page.getByRole("radio", { name: "Có mặt", checked: true })).toHaveCount(8);
  await expectNoHorizontalScroll(page);

  const student = page.getByRole("radiogroup", { name: "Điểm danh Lê Gia Bảo" });
  await student.getByRole("radio", { name: "Vắng không phép" }).click();
  await page.getByRole("button", { name: "Ghi chú cho Lê Gia Bảo" }).click();
  await page.getByLabel("Nội dung ghi chú cho Lê Gia Bảo").fill("Ốm");
  await page.getByLabel("Nội dung buổi học").fill("Lắp ráp robot dò đường");
  await page.screenshot({ path: "test-results/shots/attendance-360.png", fullPage: true });
  await page.getByRole("button", { name: "Lưu điểm danh" }).click();
  await expect(page.getByText("Đã lưu điểm danh.")).toBeVisible();

  await page.reload();
  await expect(student.getByRole("radio", { name: "Vắng không phép" })).toBeChecked();
  await expect(page.getByLabel("Nội dung ghi chú cho Lê Gia Bảo")).toHaveValue("Ốm");
  await expect(page.getByText("Đã điểm danh").first()).toBeVisible();

  // Buổi cũ đã bị khóa: chỉ xem, không có nút lưu.
  const db = sql();
  const [old] = await db`select s.id from sessions s join classes c on c.id = s.class_id where c.code = 'RB-CB01' order by s.date limit 1`;
  await db.end();
  await page.goto(`/teacher/sessions/${old!.id}/attendance`);
  await expect(page.getByText(/điểm danh bị khóa/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Lưu điểm danh" })).toHaveCount(0);

  // TKB cá nhân, dạng tuần và tháng.
  await page.goto("/teacher/timetable");
  await expect(page.getByRole("heading", { name: "TKB của tôi" })).toBeVisible();
  await expect(visibleText(page, "RB-CB01")).toBeVisible();
  await expect(page.getByText("RB-NC01")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/teacher-week-360.png", fullPage: true });
  await page.getByRole("link", { name: "Tháng" }).click();
  await expect(page.getByText(/^Tháng \d+\/\d{4}$/)).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/teacher-month-360.png", fullPage: true });
});

test("GV không điểm danh được buổi của lớp khác, kể cả mở thẳng bằng id", async ({ page }) => {
  await login(page, "gv.lan", NEW_PASSWORD);
  await expect(page).toHaveURL(/\/teacher\/dashboard$/);
  await expectNotFound(page, `/teacher/sessions/${otherSessionId}/attendance`);
  await page.goto(`/admin/sessions/${otherSessionId}`);
  await expect(page).toHaveURL(/\/teacher\/dashboard$/);
  // GV có menu Điểm danh (trong phạm vi lớp mình): buổi của lớp khác coi như không tồn tại.
  await expectNotFound(page, `/admin/attendance/${otherSessionId}`);
  await page.goto("/admin/attendance");
  await expect(page.getByRole("heading", { name: "Điểm danh", exact: true })).toBeVisible();
  await expect(page.getByText("RB-NC01")).toHaveCount(0);
});

test("Admin: TKB có bộ lọc, sửa giờ riêng một buổi, trùng lịch bị chặn, mở khóa điểm danh, buổi bù", async ({ page }) => {
  await login(page, "admin", NEW_PASSWORD);
  await expect(page).toHaveURL(/\/two-factor$/);
  await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);

  // Thời khóa biểu: tuần + tháng, bộ lọc, không tràn ngang ở 360px.
  await page.goto("/admin/timetable");
  await expect(page.getByRole("heading", { name: "Thời khóa biểu" })).toBeVisible();
  await expect(visibleText(page, "RB-NC01")).toBeVisible();
  await expectNoHorizontalScroll(page);
  // Thẻ buổi học mang bậc nền theo ca (seed: 08:00 Ca sáng, 14:00 Ca chiều, 18:00 Ca tối).
  const cardTones = await page
    .locator("a[data-tone]")
    .filter({ visible: true })
    .evaluateAll((cards) => cards.map((card) => [card.textContent!.slice(0, 5), card.getAttribute("data-tone")] as const));
  expect(cardTones.some(([start, tone]) => start === "18:00" && tone === "2")).toBe(true);
  expect(cardTones.some(([start, tone]) => start === "08:00" && tone === "0")).toBe(true);
  for (const [start, tone] of cardTones) {
    const expected = ({ "08:00": "0", "14:00": "1", "18:00": "2" } as Record<string, string>)[start];
    if (expected) expect(tone).toBe(expected);
  }
  await page.screenshot({ path: "test-results/shots/admin-week-360.png", fullPage: true });
  await page.getByLabel("Lọc theo lớp").selectOption({ label: "RB-CB01 – Robotics Cơ bản 01" });
  await page.getByRole("button", { name: "Lọc" }).click();
  await expect(visibleText(page, "RB-CB01")).toBeVisible();
  await expect(page.getByText("RB-NC01").filter({ visible: true })).toHaveCount(0);
  await page.goto("/admin/timetable?view=month");
  await expectNoHorizontalScroll(page);

  // Màn hình rộng: lưới thứ × ca và lịch tháng.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: "test-results/shots/admin-month-1280.png", fullPage: true });
  await page.goto("/admin/timetable");
  await expect(page.getByRole("columnheader", { name: "Ca" })).toBeVisible();
  await page.screenshot({ path: "test-results/shots/admin-week-1280.png", fullPage: true });
  // Nền hàng theo ca: Sáng, Chiều, Tối là ba bậc khác nhau; mọi ô của một hàng (kể cả cột hôm nay) cùng một màu nền.
  const rowTones = await page.locator("tbody tr").evaluateAll((rows) =>
    rows.map((row) => ({
      tone: row.querySelector("th")!.getAttribute("data-tone"),
      colors: [...new Set([...row.children].map((cell) => getComputedStyle(cell).backgroundColor))],
    })),
  );
  expect(rowTones.slice(0, 3).map((row) => row.tone)).toEqual(["0", "1", "2"]);
  for (const row of rowTones) expect(row.colors).toHaveLength(1);
  expect(new Set(rowTones.slice(0, 3).map((row) => row.colors[0])).size).toBe(3);
  // Tiêu đề Ca, T2, T3… canh giữa.
  const headAligns = await page.locator("thead th").evaluateAll((cells) => cells.map((cell) => getComputedStyle(cell).textAlign));
  expect(headAligns).toHaveLength(8);
  expect(new Set(headAligns)).toEqual(new Set(["center"]));
  // Mỗi giáo viên một độ đậm: ô của hai giáo viên khác nhau có màu nền khác nhau, ô của cùng một giáo viên cùng màu.
  const chipShades = await page.locator("tbody a[data-teacher]").evaluateAll((chips) =>
    chips.map((chip) => [chip.getAttribute("data-teacher")!, (chip as HTMLElement).style.getPropertyValue("--glass-bg")] as const),
  );
  const shadeByTeacher = new Map<string, Set<string>>();
  // Ô đã hủy không tô màu nên không tính.
  for (const [teacher, shade] of chipShades) if (shade) shadeByTeacher.set(teacher, (shadeByTeacher.get(teacher) ?? new Set()).add(shade));
  expect(shadeByTeacher.size).toBeGreaterThanOrEqual(2);
  for (const shades of shadeByTeacher.values()) expect([...shades]).toHaveLength(1);
  expect(new Set([...shadeByTeacher.values()].map((shades) => [...shades][0])).size).toBe(shadeByTeacher.size);
  await expect(page.locator("[data-legend]")).toHaveCount(shadeByTeacher.size);
  // Buổi đã điểm danh (07:00 RB-CB01 hôm nay) có dấu tick thay cho nền xanh lá.
  await expect(page.getByRole("link", { name: /07:00 RB-CB01/ }).filter({ visible: true })).toContainText("Đã điểm danh");

  // Xếp tay: bấm dấu + ở ô Chủ nhật × Ca chiều, chọn lớp, lưu → buổi hiện ngay trong ô.
  const sundayAfternoon = page.getByRole("button", { name: /^Xếp buổi học CN .*, Ca chiều$/ });
  await sundayAfternoon.click();
  await expect(page.getByRole("dialog")).toContainText("Chủ nhật");
  await page.locator("#f-classId").selectOption({ label: "RB-CB01 – Robotics Cơ bản 01" });
  await page.getByRole("button", { name: "Xếp vào lịch" }).click();
  await expect(page.getByText("Đã xếp buổi học.")).toBeVisible();
  await expect(page.getByRole("link", { name: /14:00 RB-CB01/ })).toBeVisible();
  // Cùng ô đó xếp lớp khác với cùng giáo viên → trùng giờ, bị chặn.
  await sundayAfternoon.click();
  await page.locator("#f-classId").selectOption({ label: "RB-NC01 – Robotics Nâng cao 01" });
  await page.locator("#f-teacherId").selectOption({ label: "GV01 – Nguyễn Thị Lan" });
  await page.getByRole("button", { name: "Xếp vào lịch" }).click();
  await expect(page.locator('[data-slot="alert"]')).toContainText("Trùng lịch: Giáo viên đã có buổi RB-CB01 lúc 14:00–15:30");
  await page.getByRole("button", { name: "Hủy", exact: true }).click();
  await page.screenshot({ path: "test-results/shots/admin-week-manual-1280.png", fullPage: true });

  // Xếp sai thì xóa: mở buổi vừa xếp, bấm "Xóa buổi" → quay về thời khóa biểu, buổi không còn.
  await page.getByRole("link", { name: /14:00 RB-CB01/ }).click();
  await expect(page.getByRole("heading", { name: /Buổi học RB-CB01/ })).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Xóa buổi" }).click();
  await expect(page).toHaveURL(/\/admin\/timetable\?date=/);
  await expect(page.getByRole("columnheader", { name: "Ca" })).toBeVisible();
  await expect(page.getByRole("link", { name: /14:00 RB-CB01/ })).toHaveCount(0);

  await page.goto("/admin/students");
  await expect(page.getByRole("columnheader", { name: "STT" })).toBeVisible();
  await expect(page.getByRole("row")).toHaveCount(11);
  await expect(page.getByRole("columnheader", { name: "STT" })).toHaveCSS("text-align", "center");
  await expect(page.getByRole("columnheader", { name: "Khối" })).toHaveCSS("text-align", "center");
  await page.goto("/admin/rooms-slots");
  await expect(page.getByRole("columnheader", { name: "STT" })).toHaveCount(2);
  await page.screenshot({ path: "test-results/shots/admin-rooms-1280.png", fullPage: true });
  // Ghi danh: ô chọn lớp chỉ rộng khoảng nửa vùng nội dung trên màn hình rộng.
  await page.goto("/admin/enrollments");
  await expect(page.getByLabel("Lớp học")).toBeVisible();
  const selectBox = (await page.getByLabel("Lớp học").boundingBox())!;
  expect(selectBox.width).toBeLessThan(560);
  await page.screenshot({ path: "test-results/shots/admin-enrollments-1280.png" });
  await page.goto("/admin/students");
  await page.screenshot({ path: "test-results/shots/admin-students-1280.png" });
  await page.setViewportSize({ width: 360, height: 740 });

  // Trên điện thoại: nút xếp buổi nằm dưới từng ngày, có thêm ô chọn ca.
  await page.goto("/admin/timetable");
  await page.getByRole("button", { name: /^Xếp buổi học ngày / }).last().click();
  await expect(page.locator("#f-timeSlotId")).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/manual-schedule-360.png" });
  await page.getByRole("button", { name: "Hủy", exact: true }).click();

  // Sửa riêng buổi hôm nay của RB-NC01 (06:00–06:45, Lab 2, GV Minh).
  await page.goto(`/admin/sessions/${otherSessionId}`);
  await expectNoHorizontalScroll(page);
  const edit = async (start: string, end: string, room: string) => {
    await page.getByRole("button", { name: "Sửa buổi này" }).click();
    await page.getByLabel("Giờ bắt đầu").fill(start);
    await page.getByLabel("Giờ kết thúc").fill(end);
    await page.getByLabel("Phòng").selectOption({ label: room });
    await page.getByRole("button", { name: "Lưu" }).click();
  };
  // Trùng phòng với buổi RB-CB01 07:00–07:45 (Lab 1) theo giờ thực tế → bị chặn.
  await edit("07:15", "08:00", "Phòng Lab 1 (12 chỗ)");
  await expect(page.locator('[data-slot="alert"]')).toContainText("Trùng lịch: Phòng đã có buổi RB-CB01 lúc 07:00–07:45");
  await page.screenshot({ path: "test-results/shots/session-conflict-360.png" });
  await page.getByRole("button", { name: "Hủy", exact: true }).click();
  // Giữ phòng riêng thì lưu được; các buổi khác của lớp không đổi giờ.
  await edit("07:15", "08:00", "Phòng Lab 2 (8 chỗ)");
  await expect(page.getByText("Đã lưu.")).toBeVisible();
  await expect(page.getByText("07:15–08:00")).toBeVisible();
  const db = sql();
  const others = await db`
    select distinct s.start_time from sessions s join classes c on c.id = s.class_id
    where c.code = 'RB-NC01' and s.id <> ${otherSessionId}`;
  expect(others.map((o) => o.start_time)).toEqual(["08:00:00"]);

  // GV Lan đang dạy 07:00–07:45 nên không thể dạy thay buổi 07:15–08:00.
  await page.getByRole("button", { name: "GV dạy thay" }).click();
  await page.locator("#f-substituteTeacherId").selectOption({ label: "GV01 – Nguyễn Thị Lan" });
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.locator('[data-slot="alert"]')).toContainText("Trùng lịch: Giáo viên đã có buổi RB-CB01");
  await page.getByRole("button", { name: "Hủy", exact: true }).click();

  // Hủy rồi khôi phục buổi.
  await page.getByRole("button", { name: "Hủy buổi" }).click();
  await page.getByLabel("Lý do").fill("Phòng bảo trì");
  await page.getByRole("dialog").getByRole("button", { name: "Hủy buổi" }).click();
  await expect(page.getByText("Đã hủy buổi học.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Điểm danh" })).toHaveCount(0);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Khôi phục buổi" }).click();
  await expect(page.getByText("Đã khôi phục buổi học.")).toBeVisible();

  // Mở khóa điểm danh một buổi cũ đã khóa.
  const [old] = await db`select s.id from sessions s join classes c on c.id = s.class_id where c.code = 'RB-CB01' order by s.date limit 1`;
  await page.goto(`/admin/attendance/${old!.id}`);
  await expect(page.getByText(/điểm danh bị khóa/)).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Mở khóa điểm danh 24 giờ" }).click();
  await expect(page.getByText("Đã mở khóa trong 24 giờ.")).toBeVisible();
  await expect(page.getByText(/điểm danh bị khóa/)).toHaveCount(0);
  await page.getByRole("radiogroup", { name: "Điểm danh Lê Gia Bảo" }).getByRole("radio", { name: "Đi trễ" }).click();
  await page.getByRole("button", { name: "Lưu điểm danh" }).click();
  await expect(page.getByText("Đã lưu điểm danh.")).toBeVisible();
  const logs = await db`select action from audit_logs where action in ('attendance_unlocked', 'attendance_updated', 'session_updated', 'session_cancelled')`;
  expect(new Set(logs.map((l) => l.action)).size).toBe(4);

  // Trang lớp chỉ còn thông tin lớp, Lịch mẫu hằng tuần và Học viên đang học: không còn Giáo viên phụ trách, Buổi học.
  const [cls] = await db`select id from classes where code = 'RB-CB01'`;
  await db.end();
  await page.goto(`/admin/classes/${cls!.id}`);
  await expect(page.getByRole("heading", { name: /Lịch mẫu hằng tuần/ })).toBeVisible();
  await expect(visibleText(page, "Thứ Ba")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Học viên đang học/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Giáo viên phụ trách/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Buổi học", exact: true })).toHaveCount(0);
  for (const name of ["Phân công", "Sinh buổi học tuần sau", "Sinh buổi học từ lịch mẫu"]) {
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  }
  for (const name of ["Xem thời khóa biểu lớp", "Thêm buổi bù"]) await expect(page.getByRole("link", { name })).toHaveCount(0);
  await expect(page.getByText(/buổi theo khóa học|Còn thiếu \d+ buổi|Tuần sau \(/)).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/class-detail-360.png", fullPage: true });

  // Thêm buổi bù chỉ cho học viên được chọn (mở từ trang buổi học; ở đây vào thẳng địa chỉ của form).
  await page.goto(`/admin/sessions/makeup?classId=${cls!.id}`);
  await page.getByLabel("Giờ bắt đầu").fill("20:00");
  await page.getByLabel("Giờ kết thúc").fill("20:45");
  await page.getByLabel(/Phạm Minh Anh/).check();
  await expectNoHorizontalScroll(page);
  await page.getByRole("button", { name: "Thêm buổi bù" }).click();
  await expect(page).toHaveURL(/\/admin\/sessions\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Học bù")).toBeVisible();
  await page.getByRole("link", { name: "Điểm danh" }).click();
  await expect(page.getByRole("radiogroup")).toHaveCount(1);
  await expect(page.getByRole("radiogroup", { name: "Điểm danh Phạm Minh Anh" })).toBeVisible();
});