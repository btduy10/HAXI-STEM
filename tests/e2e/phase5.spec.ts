import { expect, test } from "@playwright/test";
import ExcelJS from "exceljs";
import { NEW_PASSWORD, expectNoHorizontalScroll, expectNotFound, loadAdminSecret, login, sql, totp, visibleText } from "./helpers";

// Chạy sau phase1–4: admin đã bật 2FA, gv.lan đã đổi mật khẩu. Dùng lớp mới RB-TG01 để không ảnh hưởng lớp khác.
test.describe.configure({ mode: "serial" });

const tz = { timeZone: "Asia/Ho_Chi_Minh" } as const;
const today = () => new Intl.DateTimeFormat("en-CA", tz).format(new Date());
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
// Thứ ISO của hôm nay: 1 = Thứ Hai … 7 = Chủ nhật.
const isoWeekday = (iso: string) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

let classId = "";

test.beforeAll(async () => {
  const db = sql();
  const [base] = await db`select course_id, default_room_id from classes where code = 'RB-CB01'`;
  const [cls] = await db`
    insert into classes (code, name, course_id, default_room_id, start_date, end_date, max_size)
    values ('RB-TG01', 'Lớp có trợ giảng', ${base!.course_id}, ${base!.default_room_id}, ${shift(today(), -7)}, ${shift(today(), 30)}, 10)
    returning id`;
  classId = cls!.id;
  const [student] = await db`select id from students where code = 'HV001'`;
  await db`insert into enrollments (class_id, student_id, joined_at) values (${classId}, ${student!.id}, ${shift(today(), -7)})`;
  // Ca riêng sáng sớm để không trùng các buổi đã có trong dữ liệu mẫu.
  await db`insert into time_slots (name, frame, default_start, default_end) values ('Ca E2E', 1, '05:00', '05:45')`;
  await db.end();
});

test("Phân công GV chính + trợ giảng, lịch mẫu tự sinh buổi; trợ giảng điểm danh; Admin xóa buổi đã điểm danh", async ({ page, browser }) => {
  await login(page, "admin", NEW_PASSWORD);
  await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);

  // Phân công: GV02 dạy chính, GV01 (gv.lan) trợ giảng. Lương không còn đặt ở Lớp học (đặt ở Chấm công → Mức lương).
  await page.goto(`/admin/classes/${classId}`);
  const section = (heading: RegExp) => page.locator("section").filter({ has: page.getByRole("heading", { name: heading }) });
  for (const [teacher, role] of [
    ["GV02 – Trần Văn Minh", "GV chính"],
    ["GV01 – Nguyễn Thị Lan", "Trợ giảng"],
  ] as const) {
    await section(/Giáo viên phụ trách/).getByRole("button", { name: "Phân công" }).click();
    await page.locator("#f-teacherId").selectOption({ label: teacher });
    await page.locator("#f-role").selectOption({ label: role });
    await expect(page.locator("#f-ratePerSession")).toHaveCount(0);
    await page.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText("Đã lưu.")).toBeVisible();
    await expect(page.getByText("Đã lưu.")).toHaveCount(0);
  }
  await expect(section(/Giáo viên phụ trách/).getByText("Trần Văn Minh").first()).toBeVisible();
  await expect(section(/Giáo viên phụ trách/).getByText(/Lương/)).toHaveCount(0);

  // Lịch mẫu thứ hôm nay, có trợ giảng → buổi tự có trên Thời khóa biểu, không cần bấm Sinh buổi.
  await section(/Lịch mẫu hằng tuần/).getByRole("button", { name: "Thêm" }).click();
  await page.locator("#f-weekday").selectOption(String(isoWeekday(today())));
  await page.locator("#f-timeSlotId").selectOption({ label: "Ca E2E (05:00–05:45)" });
  await page.locator("#f-teacherId").selectOption({ label: "GV02 – Trần Văn Minh" });
  await page.locator("#f-assistantTeacherId").selectOption({ label: "GV01 – Nguyễn Thị Lan" });
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText(/Đã tự thêm \d+ buổi vào Thời khóa biểu\./)).toBeVisible();

  // Tên viết tắt: nhập ở menu Giáo viên (Mã GV đứng trước Họ tên), Thời khóa biểu hiện tên viết tắt thay họ tên.
  await page.goto("/admin/teachers");
  await expect(page.locator("ul:visible > li").first()).toContainText("Họ tên:");
  await page.getByRole("button", { name: "Sửa Trần Văn Minh" }).click();
  await page.locator("#f-shortName").fill("T.Minh");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã lưu.")).toBeVisible();
  await expect(page.locator("ul:visible > li").filter({ hasText: "Trần Văn Minh" })).toContainText(/Tên viết tắt:\s*T\.Minh/);
  await expectNoHorizontalScroll(page);
  await page.goto(`/admin/timetable?view=week&date=${today()}&classId=${classId}`);
  // GV02 có tên viết tắt; trợ giảng GV01 chưa đặt nên vẫn hiện họ tên.
  await expect(page.locator("a:visible").filter({ hasText: /GV: T\.Minh · Trợ giảng: Nguyễn Thị Lan/ }).first()).toBeVisible();
  await expectNoHorizontalScroll(page);

  const db = sql();
  const [session] = await db`select id from sessions where class_id = ${classId} and date = ${today()}`;
  expect(session, "buổi hôm nay phải được tự sinh").toBeTruthy();
  const sessionId = session!.id as string;

  // Trợ giảng (gv.lan) thấy lớp ở "Lớp của tôi" và điểm danh được buổi mình trợ giảng.
  const teacherContext = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  const teacher = await teacherContext.newPage();
  await login(teacher, "gv.lan", NEW_PASSWORD);
  await expect(teacher).toHaveURL(/\/teacher\/dashboard$/);
  await teacher.goto("/teacher/classes");
  await expect(teacher.getByText("RB-TG01").first()).toBeVisible();
  await teacher.goto(`/teacher/sessions/${sessionId}/attendance`);
  await teacher.getByRole("button", { name: "Lưu điểm danh" }).click();
  await expect(teacher.getByText(/Đã lưu điểm danh/)).toBeVisible();
  await teacherContext.close();

  // Admin xóa buổi đã điểm danh: hộp xác nhận nói rõ sẽ xóa kèm điểm danh.
  await page.goto(`/admin/sessions/${sessionId}`);
  await expect(page.getByText("Trợ giảng").first()).toBeVisible();
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("1 lượt điểm danh");
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Xóa buổi" }).click();
  await expect(page).toHaveURL(/\/admin\/timetable\?date=/);
  expect(await db`select id from sessions where id = ${sessionId}`).toHaveLength(0);
  expect(await db`select id from attendances where session_id = ${sessionId}`).toHaveLength(0);
  await db.end();
});

test("Lớp học thêm đã gỡ: trang Lớp học và Thời khóa biểu không còn mục này, dữ liệu cũ trong bảng không hiện lên lưới; nút Excel vẫn xuất Thời khóa biểu", async ({ page }) => {
  await login(page, "admin", NEW_PASSWORD);
  await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);

  // Bảng extra_classes được giữ lại trong CSDL: dữ liệu cũ còn nằm đó cũng không được hiện ở đâu nữa.
  const day = today();
  const db = sql();
  await db`
    insert into extra_classes (name, course_id, room_id, weekday, time_slot_id)
    select 'Toán thêm E2E', c.id, r.id, ${isoWeekday(day)}, s.id from courses c, rooms r, time_slots s limit 1`;
  await db.end();

  for (const [url, heading] of [
    ["/admin/classes", /^Lớp học/],
    [`/admin/timetable?date=${day}`, "Thời khóa biểu"],
    [`/admin/timetable?view=month&date=${day}`, "Thời khóa biểu"],
  ] as const) {
    await page.goto(url);
    await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /Lớp học thêm/ })).toHaveCount(0);
    await expect(page.getByText("Toán thêm E2E")).toHaveCount(0);
    await expect(page.getByText("Học thêm", { exact: true })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
  }

  await page.goto(`/admin/timetable?date=${day}`);
  // Không còn ô chọn loại lớp khi xuất: nút Excel luôn xuất Thời khóa biểu của lớp Robotics, không có tệp riêng cho lớp học thêm.
  await expect(page.getByLabel("Loại lớp cần xuất")).toHaveCount(0);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Excel" }).click()]);
  expect(download.suggestedFilename()).toMatch(/^thoi-khoa-bieu-.*\.xlsx$/);
  const ignored = await page.request.get(`/api/export/timetable?format=xlsx&kind=extra&from=${day}&to=${day}`);
  expect(ignored.headers()["content-disposition"]).toContain("thoi-khoa-bieu-");
});

test("Lớp chỉ hiển thị trên Thời khóa biểu: tạo ở Lớp học, ô xám và chú giải trên Thời khóa biểu; không có ở Điểm danh, Ghi danh, Học phí, Chấm công, tệp xuất; không điểm danh hay ghi sao được", async ({ page }) => {
  await login(page, "admin", NEW_PASSWORD);
  await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);

  const day = today();
  const db = sql();
  // Phòng khác với phòng của các lớp mẫu để không trùng lịch với buổi sẵn có.
  const [room] = await db`select name, capacity from rooms where id <> (select default_room_id from classes where code = 'RB-CB01') order by name limit 1`;

  // Tạo lớp ở trang Lớp học với lựa chọn Hiển thị = Chỉ trên Thời khóa biểu.
  await page.goto("/admin/classes");
  await page.getByRole("button", { name: "Thêm", exact: true }).click();
  // Form không còn ô Mã lớp (máy chủ tự cấp) và ô Khóa học (lớp không gắn với khóa).
  await expect(page.locator("#f-code")).toHaveCount(0);
  await expect(page.locator("#f-courseId")).toHaveCount(0);
  await page.locator("#f-name").fill("Mượn phòng E2E");
  await page.locator("#f-defaultRoomId").selectOption({ label: `${room!.name} (${room!.capacity} chỗ)` });
  await page.locator("#f-startDate").fill(shift(day, -7));
  await page.locator("#f-endDate").fill(shift(day, 30));
  await page.locator("#f-maxSize").fill("1");
  await expect(page.locator("#f-timetableOnly")).toHaveValue("false");
  await page.locator("#f-timetableOnly").selectOption({ label: "Chỉ trên Thời khóa biểu" });
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã lưu.")).toBeVisible();
  const [cls] = await db`select id, code, course_id, timetable_only from classes where name = 'Mượn phòng E2E'`;
  expect(cls!.timetable_only).toBe(true);
  expect(cls!.course_id).toBeNull();
  // Mã lớp tự cấp: RB + năm + số thứ tự. Cột Lớp ở trang Lớp học chỉ hiện tên lớp, không hiện mã và không có cột Khóa học.
  const lendCode = cls!.code as string;
  expect(lendCode).toMatch(new RegExp(`^RB${day.slice(2, 4)}\\d{2,}$`));
  const lendCard = page.locator("li:visible").filter({ hasText: "Mượn phòng E2E" });
  await expect(lendCard).toContainText("Chỉ Thời khóa biểu");
  await expect(lendCard).not.toContainText(lendCode);
  await expect(page.locator("li:visible").filter({ hasText: "Robotics Cơ bản 01" })).not.toContainText("RB-CB01");
  await expect(page.getByText("Khóa học:")).toHaveCount(0);
  // Sửa lớp cũng không có ô Mã lớp.
  await page.getByRole("button", { name: "Sửa Mượn phòng E2E" }).click();
  await expect(page.locator("#f-name")).toHaveValue("Mượn phòng E2E");
  await expect(page.locator("#f-code")).toHaveCount(0);
  await page.getByRole("button", { name: "Hủy" }).click();
  await expectNoHorizontalScroll(page);
  const lendId = cls!.id as string;

  // Trang chi tiết rút gọn: không có Sĩ số, phần Học viên, nút Quản lý ghi danh. Thêm lịch mẫu thứ hôm nay → buổi tự có.
  await page.goto(`/admin/classes/${lendId}`);
  await expect(page.getByText("Chỉ hiển thị trên Thời khóa biểu", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Học viên đang học/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Quản lý ghi danh" })).toHaveCount(0);
  await expect(page.getByText("Sĩ số:")).toHaveCount(0);
  const section = (heading: RegExp) => page.locator("section").filter({ has: page.getByRole("heading", { name: heading }) });
  await section(/Lịch mẫu hằng tuần/).getByRole("button", { name: "Thêm" }).click();
  await page.locator("#f-weekday").selectOption(String(isoWeekday(day)));
  await page.locator("#f-timeSlotId").selectOption({ label: "Ca E2E (05:00–05:45)" });
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText(/Đã tự thêm \d+ buổi vào Thời khóa biểu\./)).toBeVisible();
  // Xếp lại toàn bộ theo lịch mẫu để có cả buổi của tuần trước (đã qua ngày, không ai điểm danh).
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Sinh buổi học từ lịch mẫu" }).click();
  await expect(page.getByText(/Lớp có \d+ buổi/)).toBeVisible();
  await expect(page.getByText(/buổi chưa có giáo viên/)).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  const held = await db`select id, date::text as date from sessions where class_id = ${lendId} order by date`;
  await db.end();
  const todaySession = held.find((x) => x.date === day);
  expect(todaySession, "buổi hôm nay của lớp mượn phòng phải được tự sinh").toBeTruthy();
  expect(held.some((x) => x.date < day), "phải có buổi đã qua để thử nhãn Quá hạn").toBe(true);

  // Thời khóa biểu: ô xám riêng, nhãn và chú giải "Chỉ xem lịch"; buổi đã qua không bị gắn "Quá hạn".
  for (const date of [day, shift(day, -7)]) {
    await page.goto(`/admin/timetable?view=week&date=${date}&classId=${lendId}`);
    const tile = page.locator("[data-timetable-only]:visible").first();
    await expect(tile).toContainText(lendCode);
    await expect(tile).toContainText("Chỉ xem lịch");
    await expect(tile.getByText("Quá hạn")).toHaveCount(0);
    expect(await tile.evaluate((el) => (el as HTMLElement).style.getPropertyValue("--glass-bg"))).toBe("oklch(0.87 0.008 255)");
    await expect(page.locator('[data-legend="timetable-only"]')).toHaveText("Chỉ xem lịch");
    await expectNoHorizontalScroll(page);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/admin/timetable?view=week&date=${day}`);
  await expect(page.locator("tbody a[data-timetable-only]").filter({ hasText: lendCode })).toBeVisible();
  await page.goto(`/admin/timetable?view=month&date=${day}`);
  await expect(page.locator("[data-timetable-only]:visible").first()).toContainText(lendCode);
  await page.setViewportSize({ width: 360, height: 740 });

  // Trang buổi học: sửa/dời/hủy được nhưng không có Điểm danh, Ghi sao; gọi thẳng địa chỉ cũng không vào được.
  await page.goto(`/admin/sessions/${todaySession!.id}`);
  await expect(page.getByRole("heading", { name: new RegExp(`Buổi học ${lendCode}`) })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sửa buổi này" })).toBeVisible();
  await expect(page.getByRole("link", { name: /điểm danh/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Ghi sao" })).toHaveCount(0);
  await expectNotFound(page, `/admin/attendance/${todaySession!.id}`);
  await expectNotFound(page, `/admin/sessions/${todaySession!.id}/stars`);

  // Không hiện ở nơi nào khác.
  for (const url of ["/admin/attendance", "/admin/enrollments", "/admin/tuition", "/admin/timesheet", "/admin/timesheet/rates", "/admin/rewards", "/admin/syllabus", "/admin/reports"]) {
    await page.goto(url);
    await expect(page.getByRole("heading").first()).toBeVisible();
    await expect(page.getByText(new RegExp(`${lendCode}|Mượn phòng E2E`))).toHaveCount(0);
    await expect(page.locator("option").filter({ hasText: new RegExp(`${lendCode}|Mượn phòng E2E`) })).toHaveCount(0);
  }
  // Bộ lọc lớp của Thời khóa biểu và ngày nghỉ theo lớp thì có.
  await page.goto(`/admin/timetable?date=${day}`);
  await expect(page.getByLabel("Lọc theo lớp").locator("option").filter({ hasText: lendCode })).toHaveCount(1);

  // Tệp xuất Thời khóa biểu không gồm lớp này, kể cả khi lọc đúng lớp đó.
  for (const query of [`from=${day}&to=${day}`, `from=${day}&to=${day}&classId=${lendId}`]) {
    const file = await page.request.get(`/api/export/timetable?format=xlsx&${query}`);
    expect(file.ok()).toBe(true);
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await file.body()) as unknown as ArrayBuffer);
    const cells: string[] = [];
    book.eachSheet((sheet) => sheet.eachRow((row) => row.eachCell((cell) => cells.push(String(cell.value ?? "")))));
    expect(cells.join("|")).not.toContain(lendCode);
    expect(cells.join("|")).not.toContain("Mượn phòng E2E");
  }
});

test("Ghi danh: tổng quan theo buổi trong tuần (buổi - giờ, tên lớp - GV), lớp học nhiều buổi gom một bảng, mỗi lớp 8 hàng, hàng trống đánh số theo chỗ còn lại, lớp đủ sĩ số không thêm được", async ({ page }) => {
  await login(page, "admin", NEW_PASSWORD);
  await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);

  // Lớp riêng cho test: tối đa 2 học viên, học Tối Thứ 2 và Sáng Thứ 7 (chỉ có lịch mẫu, không sinh buổi).
  const day = today();
  const db = sql();
  const [base] = await db`select course_id from classes where code = 'RB-CB01'`;
  const [cls] = await db`
    insert into classes (code, name, course_id, start_date, end_date, max_size)
    values ('GD-E2E', 'Lớp thử ghi danh', ${base!.course_id}, ${shift(day, -7)}, ${shift(day, 30)}, 2)
    returning id`;
  const rosterClassId = cls!.id as string;
  await db`
    insert into schedule_templates (class_id, weekday, time_slot_id)
    select ${rosterClassId}, d.weekday, s.id
    from (values (6, 'Ca sáng'), (1, 'Ca tối')) as d(weekday, slot)
    join time_slots s on s.name = d.slot and s.frame = 1`;

  try {
    await page.goto("/admin/enrollments");
    await expect(page.getByRole("heading", { name: "Ghi danh", exact: true })).toBeVisible();
    // Lớp học 2 buổi/tuần với cùng giáo viên gom một bảng: mỗi buổi một dòng tiêu đề, theo thứ tự ngày trong tuần (Thứ 2 trên Thứ 7).
    const blocks = page.locator('[data-roster="GD-E2E"]');
    await expect(blocks).toHaveCount(1);
    // Tiêu đề: các hàng trên "Buổi - giờ", hàng dưới "Tên lớp - Tên GV" (lớp thử chưa có giáo viên nên chỉ có tên lớp).
    const lines = blocks.getByRole("heading").locator("span");
    await expect(lines).toHaveText(["Tối Thứ 2 - 18h00 - 19h30", "Sáng Thứ 7 - 08h00 - 09h30"]);
    const [upper, lower] = [(await lines.nth(0).boundingBox())!, (await lines.nth(1).boundingBox())!];
    expect(lower.y).toBeGreaterThanOrEqual(upper.y + upper.height - 1);
    await expect(blocks.getByRole("link")).toHaveText("Lớp thử ghi danh");
    // Lớp có giáo viên: tên lớp kèm tên giáo viên của buổi.
    await expect(page.locator('[data-roster="RB-CB01"]').first().getByRole("link")).toHaveText(/^Robotics Cơ bản 01 - \S/);
    // Lớp đã đóng và lớp chỉ hiển thị trên Thời khóa biểu không có trong bảng.
    await expect(page.locator('[data-roster="RB-NC01"]')).toHaveCount(0);
    await expect(page.locator("[data-roster]").filter({ hasText: "Mượn phòng E2E" })).toHaveCount(0);

    const block = blocks.nth(0);
    await expect(block.getByRole("columnheader")).toHaveText(["STT", "Họ tên HS", "Lớp"]);
    // Cả hàng tiêu đề canh giữa.
    for (const name of ["STT", "Họ tên HS", "Lớp"]) await expect(block.getByRole("columnheader", { name })).toHaveCSS("text-align", "center");
    // Màu khung theo giáo viên: lớp thử chưa có giáo viên nên màu xám; lớp có giáo viên mang màu của giáo viên.
    const headerColor = (roster: typeof block) => roster.locator("header").evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await headerColor(page.locator('[data-roster="RB-CB01"]').first())).not.toBe(await headerColor(block));
    await expect(block.locator("tbody tr")).toHaveCount(8);
    // Lớp tối đa 2 học viên: hai chỗ trống được đánh số, các hàng còn lại để trống; không còn dấu +.
    const addButtons = block.getByRole("button", { name: /Thêm \d+ học viên/ });
    await expect(addButtons).toHaveText(["Thêm 1 học viên", "Thêm 2 học viên"]);
    await expect(block.locator("tbody svg")).toHaveCount(0);
    await expect(block.getByText("0/2")).toBeVisible();
    await expectNoHorizontalScroll(page);

    // Bấm một hàng trống → hộp thoại có hai thẻ: "Thêm học viên" (chọn từ QL Học viên, mở sẵn) và "Thêm học viên mới".
    const openEnroll = async () => {
      await addButtons.first().click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("Ghi danh vào GD-E2E");
      await expect(dialog.getByRole("tab")).toHaveText(["Thêm học viên", "Thêm học viên mới"]);
      await expect(dialog.getByRole("tab", { name: "Thêm học viên", exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.locator("#f-studentId")).toBeVisible();
      await expect(page.locator("#f-joinedAt")).toHaveValue(day);
      return dialog;
    };
    // Thẻ "Thêm học viên mới": không có ô Mã HV, lưu xong báo mã vừa cấp; hàng đó có tên và khối.
    const first = "Thử Ghi Danh Một";
    await (await openEnroll()).getByRole("tab", { name: "Thêm học viên mới" }).click();
    await expect(page.locator("#f-studentId")).toHaveCount(0);
    await expect(page.locator("#f-code")).toHaveCount(0);
    await expect(page.getByRole("dialog").getByText("Mã HV")).toHaveCount(0);
    await page.locator("#f-fullName").fill(first);
    await page.locator("#f-schoolGrade").fill("5");
    await expect(page.locator("#f-joinedAt")).toHaveValue(day);
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText(/Đã ghi danh\. Mã HV: HX\d{4,}/)).toBeVisible();
    await expect(block.locator("tbody tr").nth(0)).toContainText(first);
    await expect(page.getByText("Đã ghi danh.")).toHaveCount(0);
    await expect(block.getByText("1/2")).toBeVisible();
    await expect(addButtons).toHaveText(["Thêm 1 học viên"]);
    await expect(block.locator("tbody tr").first().locator("td").last()).toHaveText("5");

    // Thẻ "Thêm học viên": em đang học lớp này không nằm trong danh sách; chọn một em đã có trong QL Học viên.
    await openEnroll();
    const options = page.locator("#f-studentId option");
    await expect(options.filter({ hasText: first })).toHaveCount(0);
    const second = (await options.nth(1).textContent())!.split(" – ")[1]!;
    await page.locator("#f-studentId").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText("Đã ghi danh.")).toBeVisible();
    await expect(block.locator("tbody tr").nth(1)).toContainText(second);
    await expect(page.getByText("Đã ghi danh.")).toHaveCount(0);
    expect(second).not.toBe(first);

    // Đủ sĩ số tối đa: vẫn 8 hàng nhưng hàng trống không bấm được nữa.
    await expect(block.getByText("2/2")).toBeVisible();
    await expect(block.locator("tbody tr")).toHaveCount(8);
    await expect(blocks.getByRole("button", { name: /Thêm \d+ học viên/ })).toHaveCount(0);
    await expectNoHorizontalScroll(page);

    // Bấm tên lớp mở danh sách ghi danh chi tiết như cũ, có đường quay lại tổng quan.
    await block.getByRole("link", { name: "Lớp thử ghi danh" }).click();
    await expect(page).toHaveURL(new RegExp(`classId=${rosterClassId}`));
    await expect(page.getByRole("button", { name: "Cho rời lớp" })).toHaveCount(2);
    await page.getByRole("link", { name: /Tổng quan ghi danh/ }).click();
    await expect(page).toHaveURL(/\/admin\/enrollments$/);
    await expect(blocks).toHaveCount(1);

    // Thứ tự xóa học viên: em còn đang học thì QL Học viên không cho xóa, thông báo nêu tên lớp.
    const removeAtStudents = async (confirmHas: string) => {
      await page.goto(`/admin/students?q=${encodeURIComponent(first)}`);
      page.once("dialog", (confirm) => {
        expect(confirm.message()).toContain(confirmHas);
        void confirm.accept();
      });
      await page.getByRole("button", { name: `Xóa ${first}` }).click();
    };
    await removeAtStudents("Em phải rời hết các lớp trước.");
    await expect(page.getByText("Học viên đang học lớp GD-E2E. Hãy cho rời lớp hoặc xóa khỏi lớp ở Ghi danh trước khi xóa học viên.")).toBeVisible();
    await expect(visibleText(page, first)).toBeVisible();

    // Bấm tên học viên trong khung lớp: Cho rời lớp (giữ lịch sử) hoặc, với Admin, Xóa khỏi lớp.
    await page.goto("/admin/enrollments");
    await block.getByRole("button", { name: first }).click();
    const manage = page.getByRole("dialog");
    await expect(manage).toContainText(`${first} – GD-E2E`);
    await expect(manage.getByRole("tab")).toHaveText(["Cho rời lớp", "Xóa khỏi lớp"]);
    await expect(page.locator("#f-leftAt")).toHaveValue(day);
    await expectNoHorizontalScroll(page);
    await manage.getByRole("button", { name: "Cho rời lớp" }).click();
    await expect(page.getByText("Đã cho rời lớp.")).toBeVisible();
    await expect(block.getByText("1/2")).toBeVisible();
    await expect(block.getByRole("button", { name: first })).toHaveCount(0);
    await expect(block.locator("tbody tr").first()).toContainText(second);

    await block.getByRole("button", { name: second }).click();
    await manage.getByRole("tab", { name: "Xóa khỏi lớp" }).click();
    await expect(manage).toContainText("Không hoàn tác được.");
    await expect(page.locator("#f-leftAt")).toHaveCount(0);
    await manage.getByRole("button", { name: "Xóa khỏi lớp" }).click();
    await expect(page.getByText("Đã xóa khỏi lớp.")).toBeVisible();
    await expect(block.getByText("0/2")).toBeVisible();
    await expect(addButtons).toHaveText(["Thêm 1 học viên", "Thêm 2 học viên"]);

    // Em đã rời lớp: giờ xóa được ở QL Học viên.
    await removeAtStudents("điểm danh và sao của em cũng bị xóa");
    await expect(page.getByText("Đã xóa.")).toBeVisible();
    await expect(page.getByText("Không tìm thấy học viên phù hợp.")).toBeVisible();

    // Màn hình rộng: các khung xếp nhiều cột, không tràn ngang.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/admin/enrollments");
    const all = page.locator("[data-roster]");
    await expect(all.nth(1)).toBeVisible();
    const [a, b] = [(await all.nth(0).boundingBox())!, (await all.nth(1).boundingBox())!];
    expect(b.y).toBe(a.y);
    expect(b.x).toBeGreaterThan(a.x);
    await expectNoHorizontalScroll(page);
    await page.setViewportSize({ width: 360, height: 740 });
  } finally {
    // Dọn lớp thử để không ảnh hưởng số liệu học phí, báo cáo ở các test sau.
    await db`delete from enrollments where class_id = ${rosterClassId}`;
    await db`delete from classes where id = ${rosterClassId}`;
    await db`delete from students where full_name like 'Thử Ghi Danh %'`;
    await db.end();
  }
});

test("Ghi danh: học viên mới với mã tự cấp, danh sách chờ lớp, xếp lớp, xếp học bù; QL Học viên có chương trình và lịch sử buổi học", async ({ page }) => {
  await login(page, "admin", NEW_PASSWORD);
  await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);

  // Hai lớp thử: HB-E2E (lớp của em vắng, đã dạy một buổi hôm qua) và HC-E2E (có buổi hôm nay để học bù).
  const day = today();
  const db = sql();
  const WAITING = "Trần Chờ Lớp";
  const WALK_IN = "Lý Học Viên Mới";
  const [base] = await db`select course_id from classes where code = 'RB-CB01'`;
  const made = await db`
    insert into classes (code, name, course_id, start_date, end_date, max_size)
    values ('HB-E2E', 'Lớp thử học bù', ${base!.course_id}, ${shift(day, -7)}, ${shift(day, 30)}, 3),
           ('HC-E2E', 'Lớp nhận học bù', ${base!.course_id}, ${shift(day, -7)}, ${shift(day, 30)}, 3)
    returning id, code`;
  const classId = (code: string) => made.find((c) => c.code === code)!.id as string;
  await db`
    insert into schedule_templates (class_id, weekday, time_slot_id)
    select ${classId("HB-E2E")}, 3, s.id from time_slots s where s.name = 'Ca tối' and s.frame = 1`;
  const [absent] = await db`
    insert into sessions (class_id, date, start_time, end_time, status, content)
    values (${classId("HB-E2E")}, ${shift(day, -1)}, '18:00', '19:30', 'done', 'Bài thử học bù') returning id`;
  const [target] = await db`
    insert into sessions (class_id, date, start_time, end_time)
    values (${classId("HC-E2E")}, ${day}, '18:00', '19:30') returning id`;

  try {
    await page.goto("/admin/enrollments");
    await expect(page.getByRole("heading", { name: "Ghi danh", exact: true })).toBeVisible();

    // Học viên mới chưa xếp lớp nhập ở mục Chờ lớp: form không có ô mã, máy chủ cấp mã HX + năm + số thứ tự.
    await expect(page.getByRole("button", { name: "Thêm học viên mới" })).toHaveCount(0);
    await page.getByRole("button", { name: "Thêm vào danh sách chờ" }).click();
    await expect(page.locator("#f-code")).toHaveCount(0);
    await expect(page.locator("#f-classId")).toHaveCount(0);
    await page.locator("#f-fullName").fill(WAITING);
    await page.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText("Đã thêm vào danh sách chờ.")).toBeVisible();
    const waitingRow = page.locator("[data-waiting]").filter({ hasText: WAITING });
    await expect(waitingRow).toHaveAttribute("data-waiting", new RegExp(`^HX${day.slice(2, 4)}\\d{2,}$`));
    const firstCode = (await waitingRow.getAttribute("data-waiting"))!;
    const waiting = page.locator(`[data-waiting="${firstCode}"]`);
    await expectNoHorizontalScroll(page);

    // Xếp lớp cho em đang chờ: chọn lớp còn chỗ, em rời danh sách chờ và có tên trong khung của lớp.
    await waiting.getByRole("button", { name: "Xếp lớp" }).click();
    await expect(page.getByRole("dialog")).toContainText(`Xếp lớp cho ${WAITING}`);
    await page.locator("#f-classId").selectOption(classId("HB-E2E"));
    await page.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText("Đã ghi danh.")).toBeVisible();
    await expect(waiting).toHaveCount(0);
    const block = page.locator('[data-roster="HB-E2E"]').first();
    await expect(block.locator("tbody tr").first()).toContainText(WAITING);
    await expect(page.getByText("Đã ghi danh.")).toHaveCount(0);

    // Hàng trống: em đang học lớp này không nằm trong thẻ "Thêm học viên"; thẻ "Thêm học viên mới" nhập và ghi danh ngay, nhận mã kế tiếp.
    await block.getByRole("button", { name: /Thêm 1 học viên/ }).click();
    await expect(page.locator("#f-studentId option").filter({ hasText: WAITING })).toHaveCount(0);
    await page.getByRole("dialog").getByRole("tab", { name: "Thêm học viên mới" }).click();
    await page.locator("#f-fullName").fill(WALK_IN);
    await page.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText(/Đã ghi danh\. Mã HV: HX\d{4,}/)).toBeVisible();
    await expect(page.getByText(`Mã HV: ${firstCode}`)).toHaveCount(0);
    await expect(block.locator("tbody tr").nth(1)).toContainText(WALK_IN);
    await expect(block.getByText("2/3")).toBeVisible();

    // Em vắng buổi hôm qua → nằm trong "Cần học bù"; xếp học ghép vào buổi hôm nay của lớp khác.
    const [student] = await db`select id from students where full_name = ${WAITING}`;
    await db`insert into attendances (session_id, student_id, status) values (${absent!.id}, ${student!.id}, 'absent')`;
    // Một buổi em có mặt, giáo viên chọn bài từ Syllabus (nhãn kèm tên khóa): hiện ở Chương trình học và tính vào số buổi đã học của khóa đó.
    const [course] = await db`select name, total_sessions from courses order by name limit 1`;
    const courseName = course!.name as string;
    const [learned] = await db`
      insert into sessions (class_id, date, start_time, end_time, status, content)
      values (${classId("HB-E2E")}, ${shift(day, -2)}, '18:00', '19:30', 'done', ${`${courseName} · Buổi 2 – Lắp ráp thử`}) returning id`;
    await db`insert into attendances (session_id, student_id, status) values (${learned!.id}, ${student!.id}, 'present')`;
    await page.reload();
    const need = page.locator(`[data-makeup="${firstCode}"]`);
    await expect(need).toContainText("Chưa xếp bù");
    await expect(need).toContainText("Bài thử học bù");
    await need.getByRole("button", { name: /^Xếp bù cho/ }).click();
    await expect(page.getByRole("dialog")).toContainText(`Xếp học bù cho ${WAITING}`);
    // Buổi của chính lớp em đang học không nằm trong danh sách chọn.
    await expect(page.locator("#f-makeupSessionId option").filter({ hasText: "HB-E2E" })).toHaveCount(0);
    await page.locator("#f-makeupSessionId").selectOption(target!.id as string);
    await page.getByRole("button", { name: "Xếp bù", exact: true }).click();
    await expect(page.getByText("Đã xếp học bù.")).toBeVisible();
    await expect(need).toContainText("Đã xếp bù");
    await expect(need).toContainText("HC-E2E");
    await expect(need.getByRole("button", { name: "Hủy xếp bù" })).toBeVisible();
    await expectNoHorizontalScroll(page);

    // Bảng điểm danh của buổi học bù có em với nhãn "Học bù".
    await page.goto(`/admin/attendance/${target!.id}`);
    await expect(page.getByText(WAITING)).toBeVisible();
    await expect(page.getByText("Học bù", { exact: true })).toBeVisible();

    // QL Học viên: hồ sơ có lịch học, chương trình học (bài đã học), số buổi đã học và lịch sử buổi học; danh sách có cột Sao.
    await page.goto(`/admin/students/${student!.id}`);
    // Lịch học: buổi học bù đã xếp ở Ghi danh (hôm nay, lớp HC-E2E) có nhãn Học bù kèm buổi vắng được bù.
    await expect(page.getByRole("heading", { name: /^Lịch học/ })).toBeVisible();
    const makeupRow = page.locator('[data-schedule="HC-E2E"]');
    await expect(makeupRow).toHaveCount(1);
    // Hàng 1: Thứ - Ngày - Giờ; hàng 2: Tên lớp - Giáo viên - Phòng; hàng 3: Bù buổi vắng ngày - lớp đã vắng.
    await expect(makeupRow).toContainText(/(Thứ \d|Chủ nhật) - \d{2}\/\d{2}\/\d{4} - 18h00 - 19h30/);
    await expect(makeupRow).toContainText("Lớp nhận học bù");
    await expect(makeupRow).toContainText(/Bù buổi vắng \d{2}\/\d{2}\/\d{4} - Lớp thử học bù/);
    await expect(makeupRow.getByText("Học bù", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Lịch sử ghi sao/ })).toHaveCount(0);
    // Chương trình học: mỗi hàng một bài em đã học xong, số bài theo Buổi của Syllabus; bài của buổi vắng không có.
    await expect(page.getByRole("heading", { name: "Chương trình đã học" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: /^Chương trình học/ })).toContainText("1 bài đã học");
    const lessonRow = page.locator('[data-lesson="HB-E2E"]');
    await expect(lessonRow).toHaveCount(1);
    await expect(lessonRow).toContainText(`${courseName} · Bài 2: Lắp ráp thử`);
    await expect(lessonRow).toContainText("Lớp thử học bù - ");
    await expect(page.getByText("Bài thử học bù")).toHaveCount(0);
    // Lịch sử buổi học: mỗi khóa em đã học một dòng "Tên khóa - Đã học: n/tổng buổi"; mỗi hàng Ngày - Tên lớp (- Giáo viên), không còn tên bài.
    await expect(page.getByRole("heading", { name: /Lịch sử buổi học/ })).toBeVisible();
    await expect(page.locator("[data-progress]")).toHaveText([`${courseName} - Đã học: 1/${course!.total_sessions} buổi`]);
    const sessionRows = page.locator('[data-session="HB-E2E"]');
    await expect(sessionRows).toHaveCount(2);
    await expect(sessionRows.first()).toContainText(/\d{2}\/\d{2}\/\d{4} - Lớp thử học bù/);
    await expect(sessionRows.filter({ hasText: "Đã xếp bù" })).toHaveCount(1);
    await expect(sessionRows.filter({ hasText: "Lắp ráp thử" })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await page.goto(`/admin/students?q=${firstCode}`);
    await expect(page.getByText(WAITING).first()).toBeVisible();
    await expect(page.getByText("Sao:").first()).toBeVisible();
  } finally {
    // Dọn dữ liệu thử để không ảnh hưởng số liệu ở các test sau.
    await db`delete from classes where code in ('HB-E2E', 'HC-E2E')`;
    await db`delete from students where full_name in (${WAITING}, ${WALK_IN})`;
    await db.end();
  }
});

test("Học phí: đặt học phí lớp, thu hai lần, theo dõi trạng thái, mở phiếu thu và giấy báo", async ({ page }) => {
  await login(page, "admin", NEW_PASSWORD);
  await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);

  // Menu Học phí nằm ngay sau Chấm công.
  await page.goto(`/admin/tuition?classId=${classId}`);
  await expect(page.getByRole("heading", { name: "Học phí", exact: true })).toBeVisible();
  const badge = (text: string) => page.locator("li").getByText(text, { exact: true }).first();
  await expect(badge("Chưa đặt học phí")).toBeVisible();
  const saved = async (text: string) => {
    await page.getByRole("button", { name: "Lưu" }).click();
    await expect(page.getByText(text)).toBeVisible();
    await expect(page.getByText(text)).toHaveCount(0);
  };

  // Lớp chưa đặt học phí: gợi ý sẵn 2,000,000 đồng/khóa; gõ số thì tự thêm dấu phẩy phân cách.
  await page.getByRole("button", { name: "Đặt học phí" }).click();
  await expect(page.locator("#f-tuitionFee")).toHaveValue("2,000,000");
  await page.locator("#f-tuitionFee").fill("");
  await page.locator("#f-tuitionFee").pressSequentially("2000000");
  await expect(page.locator("#f-tuitionFee")).toHaveValue("2,000,000");
  await saved("Đã lưu.");
  await expect(badge("Chưa đóng")).toBeVisible();

  // Thu lần 1: 500.000 đ → đóng một phần. Thu vượt số còn lại bị chặn.
  await page.getByRole("button", { name: "Thu tiền" }).first().click();
  await page.locator("#f-amount").fill("2500000");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText(/lớn hơn số còn phải đóng/).first()).toBeVisible();
  await page.locator("#f-amount").fill("500000");
  await page.locator("#f-payerName").fill("Phụ huynh E2E");
  await saved("Đã lập phiếu thu.");
  await expect(badge("Đóng một phần")).toBeVisible();

  // Phiếu thu khi chưa đóng đủ: ghi đã đóng bao nhiêu, còn bao nhiêu.
  await page.getByRole("link", { name: "In phiếu" }).first().click();
  await expect(page).toHaveURL(/\/admin\/tuition\/receipts\//);
  await expect(page.getByText("Đã đóng 500.000 đ, còn 1.500.000 đ")).toBeVisible();
  await page.goto(`/admin/tuition?classId=${classId}`);

  // Thu lần 2: số tiền mặc định = còn lại → đã đóng đủ, không còn nút Thu tiền.
  await page.getByRole("button", { name: "Thu tiền" }).first().click();
  await expect(page.locator("#f-amount")).toHaveValue("1,500,000");
  await saved("Đã lập phiếu thu.");
  await expect(badge("Đã đóng đủ")).toBeVisible();
  await expect(page.getByRole("button", { name: "Thu tiền" })).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // Phiếu thu mới nhất: số tiền bằng chữ.
  await page.getByRole("link", { name: "In phiếu" }).first().click();
  await expect(page).toHaveURL(/\/admin\/tuition\/receipts\//);
  await expect(page.getByRole("heading", { name: "Phiếu thu học phí" })).toBeVisible();
  await expect(page.getByText("Một triệu năm trăm nghìn đồng")).toBeVisible();
  await expect(page.getByText("Đã đóng đủ tiền")).toBeVisible();
  await expect(page.getByRole("button", { name: "In phiếu thu" })).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.goto(`/admin/tuition/notice?classId=${classId}`);
  await expect(page.getByRole("heading", { name: "Giấy báo học phí" }).first()).toBeVisible();
  await expect(page.getByText(/đã đóng đủ học phí/).first()).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Admin hủy một phiếu thu rồi xóa hẳn phiếu đã hủy; phiếu còn hiệu lực không có nút Xóa.
  await page.goto(`/admin/tuition?classId=${classId}`);
  await expect(page.getByRole("button", { name: "Xóa", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Hủy", exact: true }).first().click();
  await page.locator("#f-reason").fill("Ghi nhầm E2E");
  await page.getByRole("button", { name: "Hủy phiếu" }).click();
  await expect(page.getByText("Đã hủy phiếu thu.")).toBeVisible();
  await expect(page.getByText("Đã hủy", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("Xóa hẳn phiếu thu đã hủy");
    void dialog.accept();
  });
  await page.getByRole("button", { name: "Xóa", exact: true }).click();
  await expect(page.getByText("Đã xóa phiếu thu.")).toBeVisible();
  await expect(page.getByText("Đã hủy", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "In phiếu" })).toHaveCount(1);
});

test("Syllabus theo Lớp + Khóa học + Buổi: menu sau Lớp học; Admin thêm, sửa, nhập Excel theo tên lớp; GV tự soạn lớp mình, điểm danh chọn bài kèm tên khóa; hồ sơ hiện bài và số buổi đã học theo khóa", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await login(page, "admin", NEW_PASSWORD);
  await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);

  const db = sql();
  const CLASS = "Lớp có trợ giảng";
  // Khóa có sẵn ở menu Khóa học, và một khóa thứ hai để lớp học tiếp (một lớp học nhiều khóa).
  const [course] = await db`select id, name, total_sessions from courses order by name limit 1`;
  const [next] = await db`insert into courses (name, total_sessions) values ('Khóa thử Syllabus E2E', 10) returning id, name`;
  const [courseId, courseName, nextId, nextName] = [course!.id as string, course!.name as string, next!.id as string, next!.name as string];
  const saved = async (text: string | RegExp) => {
    await expect(page.getByText(text)).toBeVisible();
    await expect(page.getByText(text)).toHaveCount(0);
  };

  try {
    await page.goto(`/admin/syllabus?classId=${classId}`);
    await expect(page.getByRole("heading", { name: /^Syllabus/ })).toBeVisible();
    // Menu: … Admin, Lớp học, Syllabus, Ghi danh…
    const menu = page.getByRole("dialog");
    await expect(async () => {
      await page.getByRole("button", { name: "Mở menu" }).click();
      await expect(menu).toBeVisible({ timeout: 1000 });
    }).toPass();
    const entries = (await menu.locator("a, button").allTextContents()).map((label) => label.trim());
    const at = (name: string) => entries.indexOf(name);
    expect(at("Admin")).toBeGreaterThan(at("Giám đốc"));
    expect(at("Lớp học")).toBeGreaterThan(at("Admin"));
    expect([at("Syllabus") - at("Lớp học"), at("Ghi danh") - at("Syllabus")]).toEqual([1, 1]);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // Nút Thêm: chọn Lớp học (theo tên lớp ở menu Lớp học), chọn Khóa học (ở menu Khóa học), nhập Buổi, Tên bài/Chủ đề, Sản phẩm.
    const add = async (course: string, period: string, title: string, product = "") => {
      await page.getByRole("button", { name: "Thêm", exact: true }).click();
      await expect(page.locator("#f-classId")).toHaveValue(classId);
      await expect(page.locator("#f-classId option:checked")).toHaveText(CLASS);
      await page.locator("#f-courseId").selectOption(course);
      await page.locator("#f-period").fill(period);
      await page.locator("#f-title").fill(title);
      await page.locator("#f-product").fill(product);
      await page.getByRole("button", { name: "Lưu" }).click();
    };
    await add(courseId, "1", "Làm quen robot", "Robot E2E");
    await saved("Đã lưu.");
    await expect(visibleText(page, "Làm quen robot")).toBeVisible();
    // Cùng lớp, khóa khác cũng có Buổi 1; ô Khóa học độc lập với lớp.
    await add(nextId, "1", "Buổi 1 khóa thử E2E");
    await saved("Đã lưu.");
    // Trùng Lớp + Khóa + Buổi bị chặn.
    await add(courseId, "1", "Trùng buổi");
    await expect(page.getByText("Lớp này đã có bài ở Buổi đó của khóa học này.").first()).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "Hủy" }).click();

    // Sửa: đổi tên bài và sản phẩm; lớp và khóa của bài không đổi được.
    await page.getByRole("button", { name: `Sửa ${CLASS} · ${courseName} · Buổi 1` }).click();
    await expect(page.locator("#f-classId")).toHaveCount(0);
    await expect(page.locator("#f-courseId")).toHaveCount(0);
    await expect(page.locator("#f-period")).toHaveValue("1");
    await page.locator("#f-title").fill("Làm quen với robot E2E");
    await page.locator("#f-product").fill("Robot chào hỏi E2E");
    await page.getByRole("button", { name: "Lưu" }).click();
    await saved("Đã lưu.");
    await expect(visibleText(page, "Robot chào hỏi E2E")).toBeVisible();

    // Nhập Excel: Lớp học ghi tên lớp (hoặc mã lớp), Khóa học phải có trong menu Khóa học.
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Tải tệp mẫu" }).click()]);
    expect(download.suggestedFilename()).toBe("mau-syllabus.xlsx");
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Syllabus");
    sheet.addRow(["Khóa học", "Lớp học", "Buổi", "Tên bài/Chủ đề", "Sản phẩm"]);
    sheet.addRow([courseName, CLASS, 3, "Động cơ E2E", "Xe chạy thẳng E2E"]);
    sheet.addRow([courseName, "RB-TG01", 2, "Lắp ráp khung xe E2E", ""]);
    sheet.addRow(["Khóa lạ E2E", CLASS, 4, "Sai khóa", ""]);
    await page.getByRole("link", { name: "Nhập Excel" }).click();
    await expect(page.getByRole("heading", { name: "Nhập Syllabus từ Excel" })).toBeVisible();
    await page.locator("#file").setInputFiles({ name: "syllabus.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(await book.xlsx.writeBuffer()) });
    await page.getByRole("button", { name: "Xem trước" }).click();
    await expect(page.getByText(/2 dòng hợp lệ, 1 dòng lỗi/)).toBeVisible();
    await expect(page.getByText('Không có khóa học "Khóa lạ E2E" trong menu Khóa học')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "Nhập 2 dòng hợp lệ" }).click();
    await expect(page.getByText("Đã thêm 2 bài, cập nhật 0 bài.")).toBeVisible();

    // Bảng xem lọc theo khóa và lớp: Buổi 1 trước, rồi 2, 3; cột Lớp học chỉ hiện tên lớp; có cột Sản phẩm.
    await page.goto(`/admin/syllabus?courseId=${courseId}&classId=${classId}`);
    const cards = page.locator("li").filter({ hasText: new RegExp(`Lớp học:\\s*${CLASS}`) });
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toContainText("Làm quen với robot E2E");
    await expect(cards.nth(1)).toContainText("Lắp ráp khung xe E2E");
    await expect(cards.nth(2)).toContainText("Động cơ E2E");
    await expect(cards.nth(2)).toContainText("Xe chạy thẳng E2E");
    await expect(cards.nth(0)).not.toContainText("RB-TG01");
    await expectNoHorizontalScroll(page);
    // Lọc theo khóa thứ hai: chỉ bài của khóa đó; ô Lớp học vẫn có đủ lớp (hai ô lọc độc lập).
    await page.goto(`/admin/syllabus?courseId=${nextId}`);
    await expect(page.getByRole("heading", { name: /^Syllabus/ })).toContainText("(1)");
    await expect(visibleText(page, "Buổi 1 khóa thử E2E")).toBeVisible();
    await expect(page.locator('select[name="classId"] option').filter({ hasText: CLASS })).toHaveCount(1);

    // Buổi học hôm nay của lớp, do GV01 (gv.lan) dạy.
    const [lan] = await db`select teacher_id from "user" where username = 'gv.lan'`;
    const [session] = await db`
      insert into sessions (class_id, date, start_time, end_time, teacher_id)
      values (${classId}, ${today()}, '06:00', '06:45', ${lan!.teacher_id})
      returning id`;
    const sessionId = session!.id as string;

    // Giáo viên có menu Syllabus, tự thêm và xóa bài của lớp mình.
    const teacherContext = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
    const teacher = await teacherContext.newPage();
    await login(teacher, "gv.lan", NEW_PASSWORD);
    await expect(teacher).toHaveURL(/\/teacher\/dashboard$/);
    await teacher.goto(`/admin/syllabus?classId=${classId}`);
    await expect(teacher.getByRole("heading", { name: /^Syllabus/ })).toContainText("(4)");
    await expect(teacher.getByRole("link", { name: "Nhập Excel" })).toBeVisible();
    await teacher.getByRole("button", { name: "Thêm", exact: true }).click();
    await teacher.locator("#f-courseId").selectOption(courseId);
    await teacher.locator("#f-period").fill("9");
    await teacher.locator("#f-title").fill("Bài giáo viên soạn E2E");
    await teacher.getByRole("button", { name: "Lưu" }).click();
    await expect(teacher.getByText("Đã lưu.")).toBeVisible();
    await expect(teacher.getByRole("heading", { name: /^Syllabus/ })).toContainText("(5)");
    teacher.once("dialog", (confirm) => void confirm.accept());
    await teacher.getByRole("button", { name: `Xóa ${CLASS} · ${courseName} · Buổi 9` }).click();
    await expect(teacher.getByText("Đã xóa.")).toBeVisible();
    await expect(teacher.getByRole("heading", { name: /^Syllabus/ })).toContainText("(4)");
    await expectNoHorizontalScroll(teacher);

    // Điểm danh: ô Nội dung buổi học liệt kê bài của lớp theo khóa rồi theo buổi, dạng "Tên khóa · Buổi n – Tên bài".
    const lessonOne = `${courseName} · Buổi 1 – Làm quen với robot E2E`;
    await teacher.goto(`/teacher/sessions/${sessionId}/attendance`);
    const content = teacher.getByLabel("Nội dung buổi học", { exact: true });
    await expect(content.locator("option").filter({ hasText: / · Buổi \d/ })).toHaveText([
      `${nextName} · Buổi 1 – Buổi 1 khóa thử E2E`,
      lessonOne,
      `${courseName} · Buổi 2 – Lắp ráp khung xe E2E`,
      `${courseName} · Buổi 3 – Động cơ E2E`,
    ]);
    await content.selectOption({ label: lessonOne });
    // Chọn "Khác" thì hiện ô gõ; chọn lại bài thì ô gõ ẩn đi.
    await content.selectOption({ label: "Khác (tự nhập)" });
    await expect(teacher.getByLabel("Nội dung buổi học (tự nhập)")).toBeVisible();
    await content.selectOption({ label: lessonOne });
    await expect(teacher.getByLabel("Nội dung buổi học (tự nhập)")).toHaveCount(0);
    await teacher.getByLabel("Nhận xét của giáo viên sau buổi dạy").fill("Lớp học tốt E2E");
    await expectNoHorizontalScroll(teacher);
    await teacher.getByRole("button", { name: "Lưu điểm danh" }).click();
    await expect(teacher.getByText(/Đã lưu điểm danh/)).toBeVisible();
    await teacher.reload();
    await expect(content).toHaveValue(lessonOne);
    await expect(teacher.getByLabel("Nhận xét của giáo viên sau buổi dạy")).toHaveValue("Lớp học tốt E2E");
    await teacherContext.close();

    await page.goto(`/admin/sessions/${sessionId}`);
    await expect(page.getByText(lessonOne)).toBeVisible();
    await expect(page.getByText("Lớp học tốt E2E")).toBeVisible();

    // Hồ sơ học viên của lớp: bài này hiện ở Chương trình học kèm tên khóa, và tính 1 buổi đã học của khóa đó.
    const [enrolled] = await db`select student_id from enrollments where class_id = ${classId} and status = 'active' limit 1`;
    await page.goto(`/admin/students/${enrolled!.student_id}`);
    await expect(page.locator('[data-lesson="RB-TG01"]').filter({ hasText: `${courseName} · Bài 1: Làm quen với robot E2E` })).toHaveCount(1);
    await expect(page.locator(`[data-progress="${courseName}"]`)).toHaveText(`${courseName} - Đã học: 1/${course!.total_sessions} buổi`);
    await expectNoHorizontalScroll(page);
  } finally {
    // Khóa thử chỉ xóa được khi không còn bài Syllabus nào thuộc khóa đó.
    await db`delete from syllabus_lessons where course_id = ${nextId}`;
    await db`delete from courses where id = ${nextId}`;
    await db.end();
  }
});

test("Chấm công: đặt mức lương giáo viên theo lớp, thành tiền; chấm công bổ sung, sửa dòng công (buổi học giữ nguyên), Admin xóa công bổ sung", async ({ page }) => {
  const vn = (iso: string) => iso.split("-").reverse().join("/");
  // Một buổi đã dạy của GV01 ở lớp RB-TG01, giờ riêng để dễ tìm dòng.
  const db = sql();
  const [lan] = await db`select teacher_id from "user" where username = 'gv.lan'`;
  const taughtOn = shift(today(), -5);
  const [session] = await db`
    insert into sessions (class_id, date, start_time, end_time, teacher_id, status)
    values (${classId}, ${taughtOn}, '07:00', '07:45', ${lan!.teacher_id}, 'done')
    returning id`;
  await db.end();

  await login(page, "admin", NEW_PASSWORD);
  await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);

  await page.goto(`/admin/timesheet?classId=${classId}`);
  await expect(page.getByRole("heading", { name: "Chấm công giáo viên" })).toBeVisible();
  // Tổng công dùng tiêu đề ngắn; Chi tiết không còn cột Ca, Phòng và hiện tên lớp.
  for (const name of ["Số buổi", "Dạy thay", "Trợ giảng"]) await expect(page.getByRole("columnheader", { name, exact: true })).toBeVisible();
  for (const name of ["Số công", "Ca", "Phòng"]) await expect(page.getByRole("columnheader", { name, exact: true })).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: "07:00–07:45" })).toContainText("Lớp có trợ giảng");
  await expect(page.getByRole("row").filter({ hasText: "07:00–07:45" })).not.toContainText("Thứ");
  const lanSummary = page.getByRole("row").filter({ has: page.getByRole("link", { name: /Xuất Excel của/ }) }).filter({ hasText: "GV01" });
  await expect(lanSummary).toContainText("công chưa có mức lương");

  // Mức lương giáo viên/Nhân viên: đặt 250.000đ/buổi cho GV01 ở lớp RB-TG01; trùng Giáo viên + Lớp bị chặn.
  await page.getByRole("link", { name: "Mức lương giáo viên/Nhân viên" }).click();
  await expect(page).toHaveURL(/\/admin\/timesheet\/rates$/);
  const addRate = async (amount: string) => {
    await page.getByRole("button", { name: "Thêm", exact: true }).click();
    await page.locator("#f-teacherId").selectOption({ label: "GV01 – Nguyễn Thị Lan" });
    await page.locator("#f-classId").selectOption({ label: "RB-TG01 – Lớp có trợ giảng" });
    await page.locator("#f-rate").fill(amount);
    await page.getByRole("button", { name: "Lưu" }).click();
  };
  await addRate("250000");
  await expect(page.getByText("Đã lưu.")).toBeVisible();
  await expect(page.getByText("250.000 đ/buổi").first()).toBeVisible();
  await expect(page.getByText("Đã lưu.")).toHaveCount(0);
  await addRate("1");
  await expect(page.getByText("Giáo viên này đã có mức lương ở lớp đó.").first()).toBeVisible();
  await page.getByRole("button", { name: "Hủy" }).click();
  await expectNoHorizontalScroll(page);
  await page.getByRole("link", { name: "← Chấm công" }).click();
  await page.goto(`/admin/timesheet?classId=${classId}`);
  await expect(page.getByRole("columnheader", { name: "Thành tiền" }).first()).toBeVisible();
  await expect(lanSummary).toContainText("250.000 đ");
  await expect(lanSummary).not.toContainText("công chưa có mức lương");

  // Chấm công bổ sung: dòng công ghi tay, lớp đang lọc được điền sẵn.
  await page.getByRole("button", { name: "Chấm công bổ sung" }).click();
  await page.locator("#f-teacherId").selectOption({ label: "GV01 – Nguyễn Thị Lan" });
  await page.locator("#f-date").fill(shift(today(), -2));
  await page.locator("#f-timeSlotId").selectOption({ label: "Ca E2E – Khung 1 (05:00–05:45)" });
  await expect(page.locator("#f-classId")).toHaveValue(classId);
  await page.locator("#f-note").fill("Công bổ sung E2E");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã chấm công bổ sung.")).toBeVisible();
  const manual = page.getByRole("row").filter({ hasText: "Công bổ sung E2E" });
  await expect(manual).toContainText("Bổ sung");
  await expect(manual).toContainText(vn(shift(today(), -2)));

  // Sửa công bổ sung: đổi ngày.
  await manual.getByRole("button", { name: "Sửa" }).click();
  await page.locator("#f-date").fill(shift(today(), -3));
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã lưu.")).toBeVisible();
  await expect(manual).toContainText(vn(shift(today(), -3)));
  await expect(page.getByText("Đã lưu.")).toHaveCount(0);

  // Sửa dòng công sinh từ buổi học: chỉ đổi trên bảng công, buổi học giữ nguyên ngày.
  const taught = page.getByRole("row").filter({ hasText: "07:00–07:45" });
  await expect(taught).toContainText(vn(taughtOn));
  await taught.getByRole("button", { name: "Sửa" }).click();
  await page.locator("#f-date").fill(shift(today(), -4));
  await page.locator("#f-note").fill("Ghi nhầm ngày E2E");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã lưu.")).toBeVisible();
  await expect(taught).toContainText(vn(shift(today(), -4)));
  await expect(taught).toContainText("Đã sửa");
  const check = sql();
  const [kept] = await check`select to_char(date, 'YYYY-MM-DD') as date from sessions where id = ${session!.id}`;
  await check.end();
  expect(kept!.date).toBe(taughtOn);
  await expectNoHorizontalScroll(page);

  // Admin xóa công bổ sung.
  page.once("dialog", (dialog) => dialog.accept());
  await manual.getByRole("button", { name: "Xóa" }).click();
  await expect(page.getByText("Đã xóa công bổ sung.")).toBeVisible();
  await expect(manual).toHaveCount(0);
});

test("Báo cáo: doanh thu – chi – lãi theo tuần/tháng/năm có biểu đồ; nhập mua sắm; chi lương; xuất học phí chưa đóng", async ({ page }) => {
  const money = (n: number) => `${n.toLocaleString("vi-VN")} đ`;
  const db = sql();
  // Lớp RB-CB01 đặt học phí nhưng chưa ai đóng → có học viên trong danh sách chưa đóng học phí.
  await db`update classes set tuition_fee = 1500000 where code = 'RB-CB01'`;
  const [{ revenue }] = await db`
    select coalesce(sum(amount), 0)::int as revenue from tuition_receipts
    where status = 'active' and to_char(paid_at, 'YYYY') = ${today().slice(0, 4)}`;
  await db.end();
  expect(revenue).toBeGreaterThan(0);

  await login(page, "admin", NEW_PASSWORD);
  await page.getByLabel("Mã xác thực").fill(totp(loadAdminSecret()));
  await page.getByRole("button", { name: "Xác nhận" }).click();
  await expect(page).toHaveURL(/\/admin\/dashboard$/);

  // Doanh thu: mặc định theo tháng của năm nay; doanh thu = các phiếu thu học phí còn hiệu lực.
  await page.goto("/admin/reports");
  await expect(page.getByRole("heading", { name: "Báo cáo", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Doanh thu", exact: true })).toHaveAttribute("aria-current", "page");
  const tile = (label: string | RegExp) => page.locator("div.glass-card").filter({ has: page.getByText(label, { exact: true }) });
  await expect(tile("Tổng doanh thu")).toContainText(money(revenue));
  await expect(page.getByRole("heading", { name: "Doanh thu theo tháng" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Lãi" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/finance-month-360.png", fullPage: true });

  // Đổi kỳ xem và chỉ số của biểu đồ.
  await page.getByLabel("Xem theo").selectOption({ label: "Tuần" });
  await expect(page).toHaveURL(/view=week/);
  await expect(page.getByRole("heading", { name: "Doanh thu theo tuần" })).toBeVisible();
  await page.getByLabel("Chỉ số trên biểu đồ").selectOption({ label: "Lãi" });
  await expect(page.getByRole("heading", { name: "Lãi theo tuần" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/finance-week-360.png", fullPage: true });
  await page.getByLabel("Xem theo").selectOption({ label: "Năm" });
  await expect(page.getByRole("heading", { name: "Lãi theo năm" })).toBeVisible();
  await expect(page.getByRole("cell", { name: `Năm ${today().slice(0, 4)}` })).toBeVisible();

  // Mua sắm: thêm một khoản, thành tiền = số lượng × đơn giá, cộng vào Tổng chi.
  await page.getByRole("link", { name: "Mua sắm", exact: true }).click();
  await expect(page).toHaveURL(/tab=purchases/);
  await page.getByRole("button", { name: "Thêm", exact: true }).click();
  await page.locator("#f-item").fill("Bộ robot E2E");
  await page.locator("#f-category").fill("Thiết bị");
  await page.locator("#f-quantity").fill("2");
  await page.locator("#f-unitPrice").fill("350000");
  await expect(page.locator("#f-unitPrice")).toHaveValue("350,000");
  await page.getByRole("button", { name: "Lưu" }).click();
  await expect(page.getByText("Đã lưu.")).toBeVisible();
  await expect(page.getByText("Bộ robot E2E").first()).toBeVisible();
  await expect(page.getByText(/Tổng mua sắm tháng .*700\.000 đ/)).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.getByRole("link", { name: "Doanh thu", exact: true }).click();
  await expect(tile("Tổng chi")).toContainText("Mua sắm 700.000 đ");

  // Chi lương: lấy từ Chấm công, có dòng của GV01 (đã đặt mức lương ở lớp RB-TG01).
  await page.getByRole("link", { name: "Chi lương", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Lương giáo viên tháng/ })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "GV01" })).toContainText(/\d đ/);
  await expectNoHorizontalScroll(page);

  // Học phí chưa đóng: có học viên của RB-CB01, tải được tệp Excel và PDF.
  await page.getByRole("link", { name: "Học phí chưa đóng", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Học viên chưa đóng đủ học phí/ })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "RB-CB01" }).first()).toContainText("Chưa đóng");
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: "test-results/shots/finance-unpaid-360.png", fullPage: true });
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Excel" }).click()]);
  expect(download.suggestedFilename()).toBe("hoc-phi-chua-dong.xlsx");
  const pdf = await page.request.get("/api/export/unpaid-tuition?format=pdf");
  expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
});
