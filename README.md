# HAXI Robotics — Hệ thống quản lý Trung tâm Robotics

Ứng dụng web cho trung tâm dạy Robotics: quản lý giáo viên, học viên, lớp, thời khóa biểu, điểm danh, chấm sao và tổng kết tặng quà cuối khóa. Hai loại tài khoản: **Quản trị (Admin)** và **Giáo viên (GV)**. Học viên và phụ huynh không có tài khoản.

Cả 4 giai đoạn đã hoàn thành: nền tảng, TKB & điểm danh, sao, cuối khóa & báo cáo.

## Công nghệ

Next.js 16 (App Router) · TypeScript strict · Tailwind CSS + shadcn/ui · PostgreSQL 17 + Drizzle ORM · Better Auth (tên đăng nhập + TOTP) · Zod · ExcelJS · pdfmake · Vitest · Playwright.

## Chạy trên máy

Yêu cầu: Node.js 22+ và Docker Desktop.

```bash
cp .env.example .env          # rồi đặt BETTER_AUTH_SECRET (lệnh tạo có ghi trong tệp)
docker compose up -d          # PostgreSQL ở cổng 5432, kèm CSDL test haxi_edu_test
npm install
npm run db:migrate            # tạo bảng
npm run db:seed               # tài khoản admin + cấu hình nền (chỉ chạy khi CSDL chưa có tài khoản)
npm run dev                   # http://localhost:3000
```

### Tài khoản ban đầu

| Tên đăng nhập | Vai trò | Ghi chú |
|---|---|---|
| `admin` | Quản trị | Sau khi đổi mật khẩu phải thiết lập xác thực hai lớp (TOTP) |

Seed chỉ tạo sẵn tài khoản `admin`. Tài khoản giáo viên do Admin tạo và chỉnh sửa trên giao diện, ở trang **Tài khoản** (thêm, sửa, đặt lại mật khẩu, khóa/mở khóa), gắn với giáo viên bạn đã thêm ở menu Giáo viên.

Mật khẩu tạm là giá trị `SEED_DEFAULT_PASSWORD` trong `.env` (mặc định `Haxi@2026`). Lần đăng nhập đầu **bắt buộc đổi mật khẩu** (tối thiểu 8 ký tự, có chữ và số).

Seed mặc định **không tạo dữ liệu mẫu**: chỉ có tài khoản `admin` và cấu hình nền (tiêu chí sao, cấu hình mặc định), để Admin nhập dữ liệu thật và dùng ngay. Với CSDL đã có tài khoản, `npm run db:seed` bỏ qua, không ghi gì.

Muốn có dữ liệu mẫu để thử trên máy (2 giáo viên và tài khoản `gv.lan`, `gv.minh`, 2 lớp đã sinh buổi học, 15 học viên, phòng, ca học, quà và mốc quà), đặt `SEED_DEMO_DATA=true` khi chạy seed trên CSDL trống. Kiểm thử tự động (Playwright) tự đặt biến này.

### Xóa dữ liệu để bắt đầu lại

```powershell
npm run db:reset                # chỉ đếm số dòng sẽ xóa, chưa xóa gì
npm run db:reset -- --confirm   # xóa thật, KHÔNG hoàn tác được — hãy sao lưu trước
```

Lệnh xóa toàn bộ giáo viên, học viên, khóa học, lớp, phòng, ca học, ngày nghỉ, ghi danh, buổi học, điểm danh, sao, quà, tổng kết, nhật ký và mọi tài khoản không phải Quản trị. Giữ lại: tài khoản Quản trị (mật khẩu, 2FA), tiêu chí sao, cấu hình và bảng phân quyền. Lệnh chạy trên CSDL trong `DATABASE_URL`; để dọn CSDL đang triển khai, đặt `$env:DATABASE_URL = "<chuỗi kết nối>"` trước khi chạy.

## Lệnh thường dùng

| Lệnh | Việc |
|---|---|
| `npm run lint` | ESLint |
| `npm run typecheck` | Sinh kiểu route của Next rồi chạy `tsc` |
| `npm test` | Vitest: test đơn vị + test tích hợp trên CSDL `haxi_edu_test` (tự dựng lại schema) |
| `npm run test:e2e` | Playwright ở màn hình 360px, tự chạy server riêng (cổng 3100) trên CSDL test. Lần đầu cần `npx playwright install chromium` |
| `npm run db:generate` | Sinh migration sau khi sửa `src/db/schema` |
| `npm run db:migrate` / `db:seed` | Áp dụng migration / tạo tài khoản admin và cấu hình nền |
| `npm run db:reset` | Xóa dữ liệu nghiệp vụ, giữ tài khoản Quản trị và cấu hình (cần `-- --confirm`) |
| `.\scripts\backup.ps1` / `./scripts/backup.sh` | Sao lưu CSDL vào `backups/` (xem [scripts/restore.md](scripts/restore.md) để khôi phục) |

## Cấu trúc

```
src/
  proxy.ts              CSP theo nonce, header bảo mật, ép HTTPS, chặn sớm khi chưa đăng nhập
  app/(auth)            Đăng nhập, xác thực hai lớp, đổi mật khẩu
  app/(admin)/admin     Trang quản trị
  app/(teacher)/teacher Trang giáo viên
  app/api               Better Auth, nhập Excel Syllabus, xuất Excel/PDF
  db/schema             Schema Drizzle (migration ở ./drizzle)
  domain                Quy tắc nghiệp vụ thuần, không phụ thuộc CSDL (lịch, sao, tổng kết)
  server/services       Nghiệp vụ + PHÂN QUYỀN (nơi duy nhất quyết định ai được làm gì)
  server/actions        Server Action: chỉ là vỏ (phiên → Zod → service)
  lib/validation        Schema Zod
scripts                 migrate, seed, sao lưu, hướng dẫn khôi phục
tests/unit · tests/integration · tests/e2e
```

Nguyên tắc: mọi hàm trong `server/services` nhận `actor` lấy từ phiên ở máy chủ và tự kiểm tra quyền. Giao diện chỉ ẩn/hiện cho tiện, không phải lớp bảo vệ.

## Chức năng

### Tài khoản và phân quyền

- Đăng nhập bằng tên đăng nhập, băm Argon2id, buộc đổi mật khẩu lần đầu, khóa tạm sau 5 lần sai (15 phút), giới hạn tốc độ.
- 2FA (TOTP) bắt buộc với Admin, có mã dự phòng. Chỉ khi chạy thử mới tắt bằng biến môi trường `ADMIN_2FA_REQUIRED=false`.
- Vai trò: **Quản trị** (toàn quyền), hai vai trò có sẵn **Giáo viên**, **Giáo viên trực**, và các vai trò Admin tự tạo (vd. Lễ tân) ở **Cấu hình → Phân quyền**. Vai trò gán cho từng tài khoản ở **Admin → Tài khoản** (cột Vai trò), kể cả tài khoản gắn với giáo viên; menu Giáo viên không có cột Vai trò. Vai trò đang gán cho tài khoản thì không xóa được; vai trò đã xóa hoặc lạ không có quyền gì. Quyền của mỗi vai trò do Admin tick:
  - **Phạm vi lớp**: "Chỉ lớp của mình" (lớp được phân công; GV dạy thay có quyền trên đúng buổi mình dạy thay) hoặc "Tất cả lớp".
  - **Xem / Thêm / Sửa** theo từng menu. Tick Xem thì menu hiện trên thanh menu của vai trò đó và mở cùng trang Admin dùng, giới hạn trong phạm vi lớp.
  - **Thông tin cá nhân học viên** (ô tick riêng của từng vai trò): được xem và sửa ngày sinh, giới tính, phụ huynh, điện thoại, ghi chú của học viên ở QL Học viên và ở form học viên mới của Ghi danh. Không tick thì các ô này không hiện và máy chủ không trả, không ghi.
  - Mặc định: Giáo viên điểm danh, chấm sao lớp mình và **xem** QL Học viên (chỉ học viên lớp mình, không có thông tin cá nhân) để theo dõi tiến độ; Giáo viên trực thấy mọi lớp, hỗ trợ điểm danh, **xem + sửa** QL Học viên và có thông tin cá nhân. Migration `0023` áp các quyền QL Học viên này vào bảng phân quyền đã lưu; Admin đổi lại được trong Cấu hình.
  - Luôn chỉ Admin: xóa dữ liệu (trừ bài Syllabus, theo ô tick Xóa của menu Syllabus); Tài khoản, Nhật ký, Cấu hình; mở khóa điểm danh; tiêu chí sao.
- Thứ tự menu quản trị: Tổng quan, **Giám đốc** (Khóa học, Phòng & Ca học, Giáo viên), **Admin** (Tài khoản, Cấu hình, Nhật ký), Lớp học, **Syllabus**, Ghi danh, QL Học viên, Thời khóa biểu, Điểm danh, **Sao & Quà** (Sao, Quà & Tổng kết), Chấm công, Học phí, Báo cáo. Nhóm bấm để mở/đóng, tự mở khi đang ở trang thuộc nhóm; nhóm chỉ hiện khi vai trò được xem ít nhất một mục trong nhóm.
- Quyền được kiểm tra ở máy chủ trong từng service (`can`/`assertCan` trong `src/server/guard.ts`); ẩn menu và nút chỉ là phần hiển thị.

### Danh mục (Admin)

- Học viên (tìm kiếm; nhập ở Ghi danh, xem và sửa ở QL Học viên), Giáo viên, Khóa học, Lớp học (phân công GV), Phòng, Ca học, Ngày nghỉ. Các bảng để mã trước tên (Mã HV – Họ tên, Mã GV – Họ tên); danh sách lớp xếp tăng dần theo ngày bắt đầu.
- **Lớp chỉ hiển thị trên Thời khóa biểu** (form Thêm/Sửa lớp, ô **Hiển thị** → "Chỉ trên Thời khóa biểu"): dùng để giữ lịch phòng, ví dụ cho mượn phòng. Lớp vẫn có lịch mẫu, sinh buổi, dời/hủy buổi và được kiểm tra trùng phòng, trùng giáo viên như mọi lớp, nhưng chỉ hiện ở trang Lớp học và trên Thời khóa biểu (ô màu xám, nhãn và chú giải "Chỉ xem lịch", không gắn "Quá hạn"). Không hiện ở Điểm danh, Sao, Ghi danh, Học phí, Chấm công, Quà & Tổng kết, Syllabus, Báo cáo, Tổng quan, trang của giáo viên và tệp xuất Thời khóa biểu; máy chủ cũng từ chối điểm danh, ghi sao, ghi danh, đặt học phí, đóng lớp cho lớp này. Chỉ bật được khi lớp chưa có ghi danh, buổi đã điểm danh, sao, mức lương, công bổ sung hay bài học Syllabus; tắt thì luôn được. Số buổi sinh ra vẫn theo số buổi của khóa học.
- **Tên viết tắt của giáo viên** (menu Giáo viên, không bắt buộc, tối đa 20 ký tự): Thời khóa biểu hiện tên viết tắt thay họ tên cho gọn (GV chính, dạy thay, trợ giảng); để trống thì dùng họ tên. Tệp xuất Thời khóa biểu vẫn ghi họ tên đầy đủ.
- Ca học: ca là một trong ba lựa chọn cố định **Sáng / Chiều / Tối** (chọn, không nhập tên); mỗi ca có nhiều khung giờ. Khi thêm/sửa, chọn Ca và **Khung giờ** (Khung 1 … Khung 10) rồi nhập giờ; cùng một ca không có hai khung cùng số. Bảng Ca học gộp ô Ca, sắp các khung theo số khung. Khi nâng cấp, ca có tên khác được quy về Sáng (bắt đầu trước 12:00), Chiều (trước 17:00) hoặc Tối, và đánh lại số khung theo giờ kết thúc.
- **Lớp học không gắn với khóa học** (một lớp, vd. RB - T4, học lần lượt nhiều khóa): form Thêm/Sửa lớp không có ô Khóa học và ô Mã lớp; bảng Lớp học không có cột Khóa học và cột Lớp chỉ hiện tên lớp (các trang khác vẫn hiện "mã – tên"). **Mã lớp tự cấp**: `RB` + 2 số cuối của năm tạo + số thứ tự trong năm (RB2601, RB2602…; `src/domain/student-code.ts`, dùng chung cách tính với mã học viên), cấp ở máy chủ, hai người thêm cùng lúc không trùng, không sửa được; lớp tạo trước đây giữ mã cũ. Cột `classes.course_id` giữ lại cho dữ liệu cũ nhưng không còn được đọc hay ghi (migration `0027`). Vì lớp không còn khóa: giấy báo học phí, phiếu thu, tệp học phí chưa đóng, bảng và tệp chấm công, báo cáo tổng kết, trang chi tiết lớp, danh sách lớp của giáo viên không còn ghi tên khóa.
- **Syllabus** (mục riêng ngay sau Lớp học): chương trình dạy theo **Lớp + Khóa học + Buổi**, cột **Khóa học, Lớp học, Buổi, Tên bài/Chủ đề, Sản phẩm**; mỗi Lớp + Khóa + Buổi một bài (cùng lớp, Buổi 1 của khóa A và Buổi 1 của khóa B là hai bài riêng; Sản phẩm để trống được). Lọc theo Khóa học và Lớp học (hai ô độc lập); bảng sắp theo khóa, lớp, rồi Buổi 1 trước; lớp hiện theo tên lớp. Nút Thêm: chọn Lớp học (các lớp ở menu Lớp học, trong phạm vi của người dùng), chọn Khóa học (các khóa ở menu Khóa học), nhập Buổi, Tên bài/Chủ đề, Sản phẩm; Sửa đổi được Buổi, Tên bài/Chủ đề, Sản phẩm (lớp và khóa của bài giữ nguyên). Khóa học đang có bài Syllabus thì không xóa được. Quyền theo Cấu hình → Phân quyền: **Xem / Thêm / Sửa / Xóa** (ô tick Xóa chỉ có ở menu này) và phạm vi lớp; mặc định Giáo viên được cả bốn quyền với lớp của mình (migration `0026` áp vào bảng phân quyền đã lưu). **Nhập Excel** theo quyền Thêm, chỉ vào lớp trong phạm vi của người nhập: cột Khóa học (tên một khóa có trong menu Khóa học), Lớp học (tên lớp, hoặc mã lớp; hai lớp trùng tên thì dòng ghi tên báo lỗi kèm các mã lớp), Buổi, Tên bài/Chủ đề, Sản phẩm; xem trước báo lỗi từng dòng; bài đã có cùng Lớp + Khóa + Buổi được cập nhật tên bài và sản phẩm nếu người nhập có quyền Sửa, không thì dòng đó báo lỗi. Lớp chỉ hiển thị trên Thời khóa biểu không có Syllabus. Các migration `0024`, `0025`, `0027` đổi bảng `syllabus_lessons` (bỏ Mã môn, thêm Sản phẩm, thêm khóa học) và mỗi lần đều xóa các bài Syllabus đang có theo quyết định của chủ hệ thống; tên bài đã ghi ở các buổi đã điểm danh không bị xóa.
- **Điểm danh có tên bài và nhận xét:** ô Nội dung buổi học là ô chọn tên bài từ Syllabus của lớp ("Tên khóa · Buổi 3 – Tên bài", theo khóa rồi theo buổi), có lựa chọn "Khác (tự nhập)"; lớp chưa có syllabus thì vẫn là ô gõ. Bên dưới có khung Nhận xét của giáo viên sau buổi dạy. Cả hai được lưu khi bấm Lưu điểm danh; Admin xem ở chi tiết buổi học. Giáo viên của buổi chọn được bài của lớp mình mà không cần quyền menu Syllabus.
- **Học phí** (menu sau Chấm công; quyền Xem / Thêm / Sửa theo Cấu hình → Phân quyền, mặc định chỉ Admin):
  - Mức học phí đặt theo **lớp** (chọn lớp ở trang Học phí → Đặt học phí); mỗi học viên có thể được **giảm** riêng (số tiền + lý do). Phải đóng = học phí lớp − giảm. Lớp chưa đặt học phí được gợi ý sẵn 2,000,000 đồng/khóa; các ô nhập tiền tự thêm dấu phẩy phân cách hàng nghìn khi gõ.
  - **Thu tiền** nhiều lần được: mỗi lần là một **phiếu thu** (số `PT-000001` tăng dần; Tiền mặt / Chuyển khoản; ngày thu; người nộp). Không thu vượt số còn phải đóng. Trạng thái: Chưa đặt học phí / Chưa đóng / Đóng một phần / Đã đóng đủ; lọc theo lớp, trạng thái, mã hoặc tên học viên; có tổng Phải thu, Đã thu, Còn phải thu.
  - **In**: phiếu thu (số tiền bằng số và bằng chữ, chữ ký; dòng Tình hình học phí ghi "Đã đóng đủ tiền" hoặc "Đã đóng …, còn …") và **giấy báo học phí** từng học viên hoặc cả lớp (mỗi em một trang; có lựa chọn chỉ in em chưa đóng đủ). Mở trang rồi bấm In; đầu giấy lấy từ **Cấu hình → Thông tin trung tâm** (tên, địa chỉ, điện thoại, thông tin chuyển khoản).
  - Hủy phiếu thu chỉ Admin và phải nhập lý do; phiếu hủy được giữ lại nhưng không còn tính là đã đóng. Admin có thể xóa hẳn phiếu đã hủy (phiếu còn hiệu lực phải hủy trước; nội dung phiếu bị xóa vẫn nằm trong nhật ký, số phiếu không cấp lại). Lượt ghi danh đã có phiếu thu thì không xóa được. Mọi thao tác thu, hủy, đổi học phí, đổi mức giảm đều ghi nhật ký.
  - Giấy in chỉ có tên và mã học viên, không lấy ngày sinh, điện thoại, phụ huynh từ hồ sơ; "Người nộp" là ô nhập tay khi thu.
- Ghi danh: chặn vượt sĩ số, giữ lịch sử rời lớp.
- **Ghi danh là nơi nhập học viên, mọi thao tác ở bảng lớp:** bấm một hàng trống "Thêm n học viên" mở hộp thoại hai thẻ. **Thêm học viên** (mở sẵn): chọn em đã có trong QL Học viên; em đang học lớp đó và em đã nghỉ hẳn không nằm trong danh sách (em đang học lớp khác vẫn chọn được). **Thêm học viên mới**: nhập thông tin, không có ô Mã HV; học viên được tạo và ghi danh trong một giao dịch (lớp hết chỗ, đã đóng… thì không tạo dở), lưu xong báo mã vừa cấp. Chỉ cần quyền Thêm của menu Ghi danh; thông tin cá nhân chỉ nhập được khi vai trò được tick "Thông tin cá nhân học viên". Không còn nút Thêm học viên mới ở đầu trang; em chưa xếp được lớp nhập bằng nút **Thêm vào danh sách chờ** ở mục Chờ lớp. Nút **Ghi danh học viên** ở danh sách chi tiết của lớp vẫn giữ (lớp chưa có buổi trong tuần không có khung ở bảng tổng quan). Nhập học viên từ Excel đã gỡ.
- **Gỡ học viên khỏi lớp ngay trên bảng lớp:** bấm tên một em trong khung lớp mở hộp thoại **Cho rời lớp** (chọn ngày, giữ lịch sử; quyền Sửa của menu Ghi danh) và **Xóa khỏi lớp** (chỉ Admin, cho ghi danh nhập sai; xóa kèm điểm danh và sao của em ở lớp đó trong thời gian ghi danh).
- **Xóa học viên theo thứ tự** (QL Học viên, chỉ Admin): em còn đang học lớp nào thì bị chặn, thông báo nêu tên lớp; phải cho rời lớp hoặc xóa khỏi lớp trước. Khi em không còn ở lớp nào, Xóa sẽ xóa hẳn em cùng các lượt ghi danh cũ, điểm danh, sao, lượt xếp học bù và đổi quà (một giao dịch, có nhật ký). Vẫn chặn khi em đã có phiếu thu học phí hoặc có dữ liệu ở lớp đã đóng (tổng kết đã chốt); khi đó đổi trạng thái thành "Đã nghỉ".
- **Mã học viên tự cấp:** `HX` + 2 số cuối của năm + số thứ tự trong năm (HX2601, HX2602…; quá 99 thành HX26100; sang năm đếm lại; `src/domain/student-code.ts`). Form học viên mới không có ô mã: máy chủ luôn cấp mã kế tiếp (mã gửi kèm bị bỏ qua, hai người thêm cùng lúc không trùng mã). Mã chỉ sửa được ở form Sửa của QL Học viên.
- **Chờ lớp** (trang Ghi danh): tự động gồm học viên trạng thái Đang học mà chưa có ghi danh hiệu lực ở lớp đang mở nào (kể cả em vừa rời lớp hoặc lớp vừa đóng). Nút **Xếp lớp** ghi danh em vào một lớp còn chỗ; nút **Thêm vào danh sách chờ** nhập học viên mới chưa có lớp (mục luôn hiện với người có quyền Thêm). Không lưu khóa mong muốn riêng, dùng ô Ghi chú của học viên. Chỉ người có phạm vi "Tất cả lớp" thấy mục này.
- **Học bù bằng cách học ghép** (trang Ghi danh, mục **Cần học bù**): liệt kê các buổi vắng (có phép, không phép) trong 90 ngày gần đây của học viên đang học ở lớp đang mở. **Xếp bù** = chọn một buổi chưa dạy trong 28 ngày tới của lớp khác; em có tên trong bảng Điểm danh và Ghi sao của buổi đó với nhãn "Học bù", giáo viên của buổi thao tác được. Trạng thái: Chưa xếp bù → Đã xếp bù → Đã bù (có mặt ở buổi bù; khi đó rời danh sách); Vắng buổi bù hoặc Buổi bù đã hủy thì **Xếp lại** được. **Hủy xếp bù** khi buổi bù chưa điểm danh. Không tính vào sĩ số lớp, không đổi học phí, chấm công, tổng kết khóa. Quyền: Thêm của menu Ghi danh để xếp, Sửa để hủy. Lưu ở bảng `makeup_assignments`. Nút "Thêm buổi bù" (mở buổi riêng cho lớp) vẫn giữ.
- **QL Học viên** (tên mới của menu Học viên) để xem và sửa, không có nút Thêm; quyền gồm Xem và Sửa, xóa chỉ Admin. Danh sách có cột **Sao** (tổng sao tích lũy; cấp xem trong hồ sơ). Hồ sơ học viên có: **Lịch học** (các buổi chưa dạy trong 28 ngày tới theo Thời khóa biểu: buổi theo lịch của lớp em đang học, buổi bù mở riêng cho lớp nếu em được chọn, và buổi **Học bù** đã xếp ở Ghi danh; mỗi hàng: Thứ - Ngày - Giờ in đậm, Tên lớp - Giáo viên - Phòng, và với buổi học bù thêm "Bù buổi vắng ngày - lớp đã vắng"); **Chương trình học** (mỗi hàng một bài em đã học xong, tức buổi em có mặt, kể cả học bù: "Tên khóa · Bài 3: Tên bài" lấy từ bài giáo viên chọn trong Syllabus khi điểm danh, số bài là số Buổi; một bài của một khóa chỉ một hàng dù em học ở lớp nào; nội dung lưu trước đây không kèm tên khóa ("Buổi n – …", "Tiết n – …") vẫn đọc được; nội dung giáo viên tự gõ hiện nguyên văn; `src/domain/syllabus.ts`); **Lịch sử buổi học** (đầu mục, mỗi khóa em đã học một dòng "Tên khóa - Đã học: n/tổng buổi": n = số buổi khác nhau của khóa đó mà em có mặt, đi trễ hoặc về sớm, kể cả buổi học bù ở lớp khác, tính theo bài giáo viên chọn từ Syllabus khi điểm danh; tổng = "Tổng số buổi" của khóa ở menu Khóa học; buổi giáo viên tự gõ nội dung và các buổi ghi trước đây chưa kèm tên khóa không tính vào khóa nào; khóa đã đổi tên hoặc đã xóa thì chỉ hiện số buổi đã học; mỗi hàng: Ngày - Tên lớp - Giáo viên, kèm sao của buổi, tình trạng điểm danh và nhãn Học bù/Đã bù, không còn tên bài). Để tránh dạy trùng chương trình, các phần này hiện mọi lớp em từng học kể cả lớp ngoài phạm vi của người xem (chỉ ngày, lớp, giáo viên, tên bài, có mặt/vắng); số sao của buổi và quà vẫn theo phạm vi. Giáo viên của buổi học bù xem được hồ sơ của em học ghép.
- **Tổng quan Ghi danh theo buổi trong tuần** (trang Ghi danh khi chưa chọn lớp): mỗi lớp đang mở là một khung, ghi các buổi (ca + thứ) trong tuần của lớp. **Cùng một lớp, cùng giáo viên mà học nhiều buổi trong tuần thì gom một khung**: mỗi buổi một dòng tiêu đề, buổi sớm hơn trong tuần nằm trên (vd. "Chiều Thứ 7" rồi "Tối Chủ nhật"), chỉ một bảng học viên; buổi do giáo viên khác dạy (kể cả dạy thay trong tuần) là khung riêng của lớp đó. Buổi lấy từ **Thời khóa biểu của tuần hiện tại** (buổi chưa hủy, không tính buổi bù; buổi không gắn ca thì suy ca theo giờ bắt đầu) nên luôn khớp Thời khóa biểu; lớp không có buổi nào trong tuần thì lấy theo lịch mẫu. Tiêu đề khung: các hàng trên "Buổi - giờ" ("Tối Thứ 4 - 19h00 - 20h30"), hàng dưới "Tên lớp - Tên GV" (người thực dạy; tên viết tắt nếu có). Bảng STT · Họ tên HS · Lớp (khối của học viên), luôn 8 hàng (lớp đông hơn thì hiện đủ). Mỗi chỗ còn lại theo sĩ số tối đa là một hàng "Thêm 1 học viên", "Thêm 2 học viên"… (cần quyền Thêm của menu Ghi danh); hàng vượt sĩ số tối đa để trống. Thứ tự: theo từng ngày từ Thứ 2 đến Chủ nhật, trong ngày Sáng → Chiều → Tối, khung đứng theo buổi đầu tiên trong tuần của nó; cùng buổi thì lớp học sớm hơn đứng trước. Màu ở viền trên và nền tiêu đề khung đi theo **giáo viên** (người thực dạy): mỗi giáo viên một tông (xếp theo mã như Thời khóa biểu; ba tông đầu là vàng, xanh dương, xanh ngọc, có 12 tông rồi quay vòng), các khung của cùng một giáo viên cùng tông, đậm nhạt khác nhau và xếp xen kẽ nhạt – đậm theo thứ tự trong tuần để hai khung kề nhau khác rõ; khung chưa có giáo viên màu xám (`src/domain/roster.ts`). Giáo viên có từ khoảng 7 khung (lớp) trở lên thì có những khung không kề nhau khá gần màu; tên buổi vẫn ghi ở tiêu đề khung. Lớp đang mở không có buổi trong tuần và chưa có lịch mẫu được liệt kê ở cuối trang; không gồm lớp đã đóng và lớp chỉ hiển thị trên Thời khóa biểu. Bấm tên lớp để mở danh sách ghi danh chi tiết (lịch sử, Cho rời lớp, Xóa) như trước; bấm tên học viên để cho rời lớp hoặc xóa khỏi lớp.
- Tài khoản: tạo, đặt lại mật khẩu, khóa/mở, đặt lại 2FA.
- **Gửi tài khoản qua email:** tài khoản gắn với giáo viên có nút **Gửi tài khoản**. Admin nhập một mật khẩu tạm; hệ thống đặt lại mật khẩu của tài khoản thành mật khẩu đó (mật khẩu cũ hết hiệu lực, tài khoản bị đăng xuất khỏi mọi thiết bị, bắt đổi ở lần đăng nhập đầu) rồi gửi thư tới email của giáo viên ở menu Giáo viên, gồm tên đăng nhập, mật khẩu tạm, đường dẫn và hướng dẫn đăng nhập. Gửi thư lỗi thì mật khẩu cũ giữ nguyên. Mật khẩu đang lưu đã băm một chiều nên không gửi lại được mật khẩu hiện tại. Cần cấu hình SMTP, xem mục [Gửi email](#gửi-email).

### Thời khóa biểu và điểm danh

- **Phân công giáo viên:** mỗi GV của lớp có vai trò GV chính hoặc Trợ giảng (sửa được). Lương không đặt ở Lớp học mà ở Chấm công → Mức lương giáo viên/Nhân viên.
- **Lịch mẫu & sinh buổi:** mỗi lớp nhiều dòng lịch mỗi tuần: thứ, ca, phòng, GV chính, trợ giảng (nếu có). Lớp không gắn với khóa học nên không có số buổi cố định: buổi được xếp cho mọi tuần từ Ngày bắt đầu đến Ngày kết thúc của lớp, bỏ ngày nghỉ; không còn giới hạn theo số buổi của khóa và không tự lùi ngày kết thúc. Lớp học tiếp khóa sau thì dời Ngày kết thúc rồi bấm sinh thêm buổi. Thêm dòng lịch mẫu (hoặc đổi thứ) là tự có buổi từ hôm nay đến ngày kết thúc của lớp; sửa dòng lịch mẫu thì các buổi sắp tới chưa điểm danh tự đổi theo (chỉ những phần chưa sửa tay; đổi thứ thì sinh lại). Buổi bị trùng lịch được bỏ qua và báo lại, không xếp sang tuần sau. Nút "Sinh buổi học từ lịch mẫu" xếp lại toàn bộ buổi chưa dạy của lớp (kể cả buổi xếp tay, đã sửa riêng) đúng thứ, ca, phòng, GV của lịch mẫu cho cả thời gian của lớp, từ ngày bắt đầu (buổi 1 luôn vào đúng ngày khai giảng, dùng ca/phòng/GV của dòng lịch mẫu có buổi sớm nhất), nên các tuần đã qua còn thiếu buổi cũng được bổ sung; buổi đã điểm danh/ghi sao và buổi đã hủy giữ nguyên.
- **Giờ riêng từng buổi:** giờ được sao chép từ ca lúc sinh; sửa một buổi không đổi ca gốc hay buổi khác, sửa ca không đổi buổi đã sinh.
- **Trùng lịch:** hai buổi cùng ngày chỉ trùng khi **cùng Ca + Khung giờ** (cùng một dòng Ca học) mà có chung GV thực dạy (đã tính dạy thay), trợ giảng, hoặc cùng phòng. Khác khung giờ thì không trùng, kể cả khi giờ hai khung chồng nhau — giáo viên dạy nhiều ca, nhiều khung trong ngày là bình thường. Buổi bù giờ tự do (không gắn ca) so theo khoảng giờ thực tế. Trùng thì **chặn** (khi sinh buổi: bỏ qua và báo lại); vượt sức chứa phòng thì **cảnh báo** nhưng vẫn lưu. Một lớp không có hai dòng lịch mẫu cùng Thứ + Ca + Khung giờ (thêm/sửa bị chặn); dòng lặp có sẵn trong dữ liệu cũ được bỏ qua khi sinh buổi, không báo trùng với chính lớp đó.
- **Điều chỉnh:** sửa riêng một buổi (giờ, phòng, GV chính, trợ giảng), dời buổi (giữ ngày gốc), hủy/khôi phục, GV dạy thay (lưu cả GV gốc và GV thay), buổi bù chỉ gồm học viên được chọn. Admin xóa hẳn được buổi xếp sai, kể cả buổi đã điểm danh/ghi sao: điểm danh và sao của buổi bị xóa theo; lớp đã đóng thì không xóa.
- **Trợ giảng** thấy lớp ở "Lớp của tôi", có buổi trong TKB của mình và được điểm danh, ghi sao các buổi mình trợ giảng.
- **Chấm công** (quyền Xem / Thêm / Sửa theo Cấu hình → Phân quyền; phạm vi "lớp của mình" chỉ thấy và thao tác công của chính mình): mỗi buổi đã điểm danh là một công cho người thực dạy và một công trợ giảng cho trợ giảng. Trang và tệp Excel (tổng hợp, từng giáo viên) có cột Mức lương và Thành tiền. Bảng Tổng công (Số buổi, Dạy thay, Trợ giảng…) xếp theo mã giáo viên; bảng Chi tiết buổi dạy xếp tăng dần theo ngày rồi giờ dạy, cột Thứ ghi gọn (Hai … Bảy, Chủ nhật), cột Lớp là tên lớp.
  - **Mức lương giáo viên/Nhân viên** (nút trước Chấm công bổ sung): đặt mức lương mỗi buổi theo từng lớp cho giáo viên, trợ giảng (chọn Giáo viên, Lớp dạy, nhập Mức lương); mỗi giáo viên một mức ở mỗi lớp. Thành tiền = số công đã dạy × mức lương của đúng giáo viên ở đúng lớp; công ở lớp chưa đặt mức lương được báo riêng, không cộng tiền. Đặt mức lương cần quyền Sửa và phạm vi "Tất cả lớp" (người chỉ thấy công của mình không tự đặt lương, chỉ thấy tiền của chính mình); xóa mức lương chỉ Admin.
  - **Chấm công bổ sung** (quyền Thêm): dòng công ghi tay gồm Giáo viên, Ngày, Ca – Khung giờ, Lớp, Vai trò, Ghi chú; chỉ nằm ở bảng Chấm công, không tạo buổi học. Xóa công bổ sung chỉ Admin.
  - **Sửa chấm công** (quyền Sửa): sửa Ngày, Ca – Khung giờ, Lớp của mọi dòng công. Với dòng sinh từ buổi học, phần sửa chỉ áp dụng trên bảng công (dòng có nhãn "Đã sửa"); Thời khóa biểu và điểm danh giữ nguyên; sửa về đúng giá trị của buổi thì bỏ nhãn.
  - Một giáo viên không có hai dòng công cùng Ngày + Ca + Khung giờ.
- **Thời khóa biểu:** lưới tuần thứ × ca và lịch tháng; Admin lọc theo GV/lớp/phòng; xuất Excel/PDF.
- **Màu theo giáo viên trên Thời khóa biểu:** mỗi giáo viên đang dạy một màu riêng theo ba tông thương hiệu vàng, xanh dương, xanh ngọc (xếp theo mã, lần lượt từng tông; hết ba tông thì quay vòng với mức đậm hơn; `src/domain/timetable-colors.ts`), tô theo người thực dạy (giáo viên dạy thay nếu có). Buổi đã điểm danh có dấu tick xanh; buổi đã hủy không tô màu. Phía trên lưới có chú giải màu. Từ khoảng 10 giáo viên đang dạy trở lên thì hai mức đậm liền nhau của cùng một tông khá gần nhau; tên giáo viên vẫn ghi trong ô.
- **Nền theo ca trên Thời khóa biểu:** các khung cùng ca cùng một độ sáng; Ca sáng giữ nền trang, Ca chiều đậm hơn một bậc, Ca tối đậm nhất (biến `--shift-1..3` trong `globals.css`, cùng tông kem, chỉ đổi độ sáng; bậc lấy từ `shiftTone` ở `src/domain/time-slots.ts`). Trên điện thoại, thẻ buổi học tô theo giáo viên (không theo ca). Ô và thẻ buổi học dùng kiểu Liquid (mặt kính bán trong suốt, viền sáng, bóng mềm; các utility `glass-*`), chỉ bằng CSS, không dùng blur và không tải thêm ảnh.
- **Điểm danh trên điện thoại:** danh sách chỉ gồm học viên đang ghi danh tại ngày học, mặc định "Có mặt", lưu cả lớp một lần.
- **Khóa sửa điểm danh** sau N ngày (mặc định 7, sửa ở trang Cấu hình). Chỉ Admin mở khóa, mỗi lần 24 giờ.

### Sao

- **Ghi sao theo buổi** cho từng em, một nhóm hoặc cả lớp. Số sao lấy từ tiêu chí ở máy chủ.
- **Sổ cái chỉ thêm:** `star_logs` không sửa, không xóa (có trigger ở CSDL). Hoàn tác tạo bản ghi đảo dấu, mỗi lần ghi chỉ hoàn tác được một lần. Ngoại lệ chỉ dành cho Admin, đều có ghi Nhật ký: (1) xóa hẳn một dòng ghi danh nhập sai ở trang Ghi danh thì điểm danh và lịch sử sao của học viên ở lớp đó, trong thời gian ghi danh, bị xóa theo; (2) xóa hẳn một buổi học thì sao của buổi bị xóa theo; (3) xóa hẳn một học viên đã rời hết các lớp thì sao của em bị xóa theo. Hồ sơ học viên không còn mục Lịch sử ghi sao và các nút xóa sao; ghi nhầm thì Hoàn tác ở Sao → Sổ cái.
- **Hai loại tổng sao**, đều tính khi truy vấn bằng `GREATEST(0, SUM(stars))` và không lưu cứng: tổng toàn thời gian (tổng sao tích lũy của học viên, đổi quà) và tổng theo lớp (xếp hạng, tặng quà).
- **Giới hạn trừ sao:** mỗi học viên bị trừ tối đa N sao/buổi (mặc định 3, sửa ở trang Cấu hình).
- **Đã gỡ Avatar và Cấp bậc:** ứng dụng chỉ còn sao. Trang **Sao** còn hai tab Tiêu chí và Sổ cái; bảng Ghi sao, danh sách học viên của lớp và hồ sơ học viên chỉ hiện tên và tổng sao; không còn thông báo lên/tụt cấp. Các bảng `levels`, `avatars`, `student_avatar_gifts` và cột `students.current_avatar_id` vẫn nằm trong CSDL với dữ liệu cũ nhưng không còn mã nào đọc hay ghi; chỉ xóa bằng một migration riêng khi chủ hệ thống đồng ý.

### Cuối khóa và báo cáo

- **Đóng lớp & chốt tổng kết** (Admin): lưu ảnh chụp tổng sao khóa, tỷ lệ chuyên cần và xếp hạng vào `course_summaries`. Phải xử lý hết buổi đã qua chưa điểm danh trước; các buổi tương lai còn lại bị hủy. Sau khi đóng, lớp không điểm danh, ghi sao hay ghi danh thêm được nữa.
- **Chuyên cần** = (có mặt + đi trễ + về sớm) ÷ số buổi đã dạy mà học viên thuộc danh sách; không kể buổi hủy và buổi chưa dạy.
- **Xếp hạng** theo tổng sao của lớp, đồng hạng kiểu 1-2-2-4.
- **Mốc quà** đặt theo lớp. Mỗi học viên nhận quà của mốc cao nhất đạt được. Mốc quà theo khóa học trước đây đã được chép thành mốc riêng của từng lớp thuộc khóa đó (lớp đã có mốc riêng thì không chép, vì trước giờ lớp đó không dùng mốc của khóa; migration `0027`).
- **Đổi quà bằng sao trong khóa học:** ở hồ sơ học viên, người có quyền Sửa ở menu Quà & Tổng kết (theo Cấu hình → Phân quyền) đổi quà cho học viên bất cứ lúc nào em đủ sao theo Mốc quà của lớp đang học. Mỗi lần đổi trừ "sao còn lại" đúng bằng mốc sao và trừ 1 tồn kho; tổng sao tích lũy không đổi. Chỉ Admin hủy được lần đổi ghi nhầm (trả lại sao và tồn kho).
- **Quy trình trao quà:** hệ thống đề xuất → Admin chọn và duyệt → ghi nhận đã trao (ngày, người trao, trừ tồn kho). Có bảng số lượng quà cần chuẩn bị so với tồn kho.
- **Báo cáo** (menu Báo cáo; quyền Xem / Thêm / Sửa theo Cấu hình → Phân quyền **và** phạm vi "Tất cả lớp", mặc định chỉ Admin) là báo cáo tài chính của cả trung tâm, gồm bốn mục:
  - **Doanh thu:** xem theo Tuần (12 tuần tới tuần chứa ngày mốc), Tháng (12 tháng của năm) hoặc Năm (5 năm gần nhất); ba ô tổng Doanh thu – Chi – Lãi; biểu đồ cột của chỉ số đang chọn (Doanh thu / Chi / Lãi, kỳ lỗ vẽ dưới trục 0) và bảng từng kỳ. Doanh thu = phiếu thu học phí còn hiệu lực theo ngày thu; Chi = chi lương + mua sắm; Lãi = Doanh thu − Chi.
  - **Chi lương:** lương tháng của từng giáo viên, tự tính từ Chấm công (số công đã dạy × mức lương ở từng lớp); công chưa có mức lương được báo riêng.
  - **Mua sắm:** nhập Ngày mua, Hạng mục mua, Loại (nhóm chi gõ tự do, có gợi ý các loại đã nhập), Số lượng, Đơn giá; Thành tiền = Số lượng × Đơn giá. Thêm/Sửa theo quyền, xóa chỉ Admin.
  - **Học phí chưa đóng:** học viên còn phải đóng (chưa đóng hoặc đóng một phần) ở các lớp đã đặt học phí, lọc theo lớp, xuất Excel/PDF. Tệp chỉ có mã, họ tên, lớp và số tiền — không có điện thoại, phụ huynh, ngày sinh.
  - Báo cáo lớp (điểm danh, sao theo học viên) đã bỏ ở cả menu Báo cáo lẫn khu giảng dạy; số liệu sao và chuyên cần của lớp vẫn xem ở Sao & Quà → Quà & Tổng kết.
- **Xuất Excel/PDF:** thời khóa biểu, tổng kết (kèm danh sách trao quà có cột ký nhận để in), chấm công, danh sách học phí chưa đóng. Mỗi lần xuất được ghi vào nhật ký.
- **Nhật ký** (Admin): lọc theo hành động, bảng, khoảng ngày; xem giá trị cũ/mới.
- **Cấu hình** (Admin): số ngày khóa điểm danh, giới hạn trừ sao mỗi buổi.

## Giao diện

Kiểu "cửa sổ kính" trên nền thiên nhiên mờ; mọi trang dùng chung một bộ token nên trông nhất quán.

- **Token màu, bo góc** nằm ở một chỗ: khối `:root` trong `src/app/globals.css` (xanh lá ngọc `#2E7D5B`, teal `#4DD0C0` cho mục/tab đang chọn, navy `#0E2841`, nền kem `#FDF8F2`, vàng đồng của logo). Font Be Vietnam Pro (400/500/600) nạp bằng `next/font` ở `src/app/layout.tsx`.
- **Nền:** xanh ngọc chuyển dọc (sáng ở trên, ngả xanh lam và đậm dần xuống dưới), cố định toàn trang. Màu nằm ở utility `app-bg` trong `globals.css`, hiển thị qua `src/components/app-background.tsx`; chỉ là CSS, không tải ảnh. Đổi màu nền thì tính lại tương phản chữ trên `glass-window`.
- **Ba cấp kính** (class trong `globals.css`): `glass-card` cho thẻ số liệu và biểu đồ; `glass-solid` (trắng 90%) cho bảng, form, dòng danh sách; `glass-sidebar` cho thanh điều hướng. Vùng nội dung là một `glass-window` đặt cạnh `<main>` trong `src/components/app-shell.tsx`.
- **Blur** (`backdrop-filter`) chỉ bật ở thanh điều hướng, cửa sổ nội dung và thẻ đăng nhập, từ 768px trở lên; điện thoại dùng nền gần đặc. Không bọc nội dung trang trong phần tử có `backdrop-filter` hay `transform`: thanh Lưu cố định ở Điểm danh/Chấm sao sẽ lệch.
- **Bố cục:** từ 1280px thanh điều hướng đầy đủ; 768–1279px thu thành dải icon; dưới 768px là menu trượt. Bề rộng thanh điều hướng nằm trong biến `--sidebar-w`.
- **Hiệu ứng** (CSS thuần, không thêm thư viện): thẻ Tổng quan hiện lần lượt (`stagger`), số KPI đếm tăng (`src/components/count-up.tsx`), biểu đồ vẽ dần (`chart-grow-*`, `chart-draw`), thẻ nổi khi rê chuột (`card-lift`), pill teal trượt giữa các mục menu, nội dung hiện dần khi chuyển trang. Tất cả tắt khi máy bật "giảm chuyển động".
- **Ảnh so sánh giao diện:** `SHOTS=<tên bộ ảnh> npm run test:e2e` chụp các trang chính ở 360/768/1280/1920px vào `ui-shots/<tên bộ ảnh>/` (không commit).

## Gửi email

Nút **Gửi tài khoản** gửi thư qua SMTP bằng `nodemailer`. Chưa khai báo thì nút báo "Chưa cấu hình gửi email", các chức năng khác không ảnh hưởng.

| Biến | Giá trị |
|---|---|
| `SMTP_USER` | Địa chỉ hộp thư dùng để gửi (vd. Gmail của trung tâm) |
| `SMTP_PASS` | Mật khẩu ứng dụng của hộp thư đó (không phải mật khẩu đăng nhập Gmail) |
| `SMTP_HOST` | Tùy chọn, mặc định `smtp.gmail.com` |
| `SMTP_PORT` | Tùy chọn, mặc định `465` (TLS ngay từ đầu); cổng khác như `587` dùng STARTTLS |
| `MAIL_FROM` | Tùy chọn, mặc định `HAXI STEM <SMTP_USER>` |

Với Gmail:

1. Đăng nhập tài khoản Google của trung tâm, vào **Bảo mật** và bật **Xác minh 2 bước**.
2. Mở <https://myaccount.google.com/apppasswords>, tạo một mật khẩu ứng dụng (đặt tên vd. "HAXI STEM"). Google hiện 16 ký tự; đó là giá trị của `SMTP_PASS`.
3. Trên Vercel: **Settings → Environment Variables**, thêm `SMTP_USER` và `SMTP_PASS` cho môi trường Production, rồi **Redeploy**. Chạy trên máy thì thêm vào tệp `.env`.

Thư chứa mật khẩu tạm ở dạng chữ thường và một bản sao nằm trong hộp **Đã gửi** của hộp thư gửi đi, nên người nhận luôn bị bắt đổi mật khẩu ở lần đăng nhập đầu. Phần gửi qua máy chủ thư thật **chưa được chạy thử** (test dùng máy chủ thư giả lập); sau khi khai báo hãy gửi thử cho một tài khoản.

## Triển khai trên Vercel

Vercel không chạy Docker nên cần một PostgreSQL bên ngoài. Repo đã có `vercel.json`: mỗi lần build chạy `npm run db:migrate` rồi `npm run build`, hàm chạy ở vùng Singapore (`sin1`). Gói Hobby của Vercel chỉ dành cho mục đích phi thương mại.

1. **Vercel → Add New → Project** → nhập repo này. Không cần sửa lệnh build.
2. **Tạo CSDL:** trong dự án, vào **Storage → Create Database → Neon** (chọn vùng Singapore). Vercel tự thêm biến `DATABASE_URL` (đã là địa chỉ pooler). Nếu tự tạo CSDL ở nơi khác thì thêm `DATABASE_URL` bằng tay, dùng chuỗi kết nối pooler có `sslmode=require`.
3. **Settings → Environment Variables**, thêm:

   | Biến | Giá trị |
   |---|---|
   | `BETTER_AUTH_SECRET` | Chuỗi ngẫu nhiên 32 byte: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
   | `DB_PREPARE` | `false` (pooler kiểu PgBouncer không hỗ trợ prepared statement) |
   | `DB_POOL_MAX` | `3` (mỗi hàm serverless có pool riêng) |

   Khi chỉ chạy thử, có thể thêm `ADMIN_2FA_REQUIRED` = `false` để Admin không bị bắt thiết lập xác thực hai lớp. Xóa biến này (rồi deploy lại) trước khi nhập dữ liệu thật của học viên.

   Không cần đặt `BETTER_AUTH_URL`: ứng dụng tự lấy địa chỉ production của dự án. Chỉ đặt khi muốn dùng một tên miền khác với tên miền production chính.
4. **Deploy** (hoặc Redeploy nếu lần đầu thiếu biến). Bảng được tạo tự động ở bước build.
5. **Tạo tài khoản đầu tiên** bằng cách chạy seed từ máy của bạn, trỏ vào CSDL đó (chuỗi kết nối xem ở Storage → `.env.local`). Đặt mật khẩu tạm riêng, đừng dùng mặc định trên trang công khai:

   ```powershell
   $env:DATABASE_URL = "<chuỗi kết nối>"; $env:SEED_DEFAULT_PASSWORD = "<mật khẩu tạm của bạn>"; npm run db:seed
   ```

   Seed tạo tài khoản `admin` và cấu hình nền, không có dữ liệu mẫu. Đăng nhập `admin` ngay sau đó để đổi mật khẩu và bật 2FA. Tài khoản GV và Admin khác tạo ở trang **Tài khoản**.

Khác biệt khi chạy trên Vercel:

- Giới hạn tốc độ của Server Action/API (lưu trong bộ nhớ tiến trình) không đáng tin vì các lần gọi có thể chạy ở những tiến trình khác nhau. Giới hạn đăng nhập và khóa tài khoản lưu trong CSDL nên vẫn đúng.
- `scripts/backup.*` không dùng được (dựa vào Docker); dùng tính năng sao lưu/khôi phục của nhà cung cấp CSDL.
- Chỉ đăng nhập được ở địa chỉ production. Địa chỉ xem trước (preview) có tên miền khác nên bị từ chối, và mỗi bản preview cũng chạy migration vào cùng CSDL.
- Cấu hình này **chưa được chạy thật trên Vercel**. Sau lần deploy đầu hãy thử: đăng nhập, thiết lập 2FA, điểm danh, và xuất một tệp PDF.

## Triển khai trên Netlify (phương án khác)

Netlify không chạy Docker nên cần một PostgreSQL bên ngoài (Neon, Supabase…). Repo đã có `netlify.toml`: mỗi lần build sẽ chạy `npm run db:migrate` rồi `npm run build`.

1. **Tạo CSDL** (ví dụ Neon, chọn vùng Singapore) và lấy chuỗi kết nối dạng **pooler** (`...-pooler...`, có `sslmode=require`).
2. **Netlify → Add new site → Import an existing project** → chọn repo này. Giữ nguyên lệnh build mà Netlify đọc từ `netlify.toml`.
3. **Site configuration → Environment variables**, thêm:

   | Biến | Giá trị |
   |---|---|
   | `DATABASE_URL` | Chuỗi kết nối pooler của CSDL |
   | `BETTER_AUTH_SECRET` | Chuỗi ngẫu nhiên 32 byte: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
   | `DB_PREPARE` | `false` (pooler kiểu PgBouncer không hỗ trợ prepared statement) |
   | `DB_POOL_MAX` | `3` (mỗi hàm serverless có pool riêng) |
   | `CLIENT_IP_HEADER` | `x-nf-client-connection-ip` (IP thật của client để giới hạn tốc độ đăng nhập) |

   Không cần đặt `BETTER_AUTH_URL` nếu dùng địa chỉ chính của trang (ứng dụng tự lấy biến `URL` của Netlify). Nếu gắn tên miền riêng, đặt `BETTER_AUTH_URL` bằng địa chỉ đó.
4. **Deploy.** Bảng được tạo tự động ở bước build.
5. **Tạo tài khoản đầu tiên** bằng cách chạy seed từ máy của bạn, trỏ vào CSDL đó. Đặt mật khẩu tạm riêng, đừng dùng mặc định trên trang công khai:

   ```powershell
   $env:DATABASE_URL = "<chuỗi kết nối>"; $env:SEED_DEFAULT_PASSWORD = "<mật khẩu tạm của bạn>"; npm run db:seed
   ```

   Seed tạo tài khoản `admin` và cấu hình nền, không có dữ liệu mẫu. Đăng nhập `admin` ngay sau đó để đổi mật khẩu và bật 2FA.

Khác biệt khi chạy trên Netlify:

- Giới hạn tốc độ của Server Action/API (lưu trong bộ nhớ tiến trình) gần như không có tác dụng vì mỗi lần gọi có thể chạy ở một tiến trình khác. Giới hạn đăng nhập và khóa tài khoản lưu trong CSDL nên vẫn đúng.
- `scripts/backup.*` không dùng được (dựa vào Docker); dùng tính năng sao lưu của nhà cung cấp CSDL.
- Chỉ dùng địa chỉ chính của trang. Địa chỉ xem trước (deploy preview) có tên miền khác nên đăng nhập sẽ bị từ chối.
- Cấu hình này đã được kiểm tra bằng bản build cục bộ của Netlify tới bước đóng gói, **chưa được chạy thật trên Netlify**. Sau lần deploy đầu hãy thử: đăng nhập, thiết lập 2FA, điểm danh, và xuất một tệp PDF.

## Bảo mật

- **Phân quyền ở máy chủ:** GV truy cập lớp, buổi học, học viên hay báo cáo của lớp khác đều nhận 404 (không lộ sự tồn tại). Có test ở tầng service và test gọi trực tiếp qua HTTP.
- **Phiên:** cookie `httpOnly`, `SameSite=Lax`, `Secure` ở production; phiên được đọc lại từ CSDL mỗi request nên khóa tài khoản có hiệu lực ngay.
- **CSRF:** Better Auth và Server Action kiểm tra Origin; Route Handler ghi dữ liệu tự kiểm tra Origin.
- **Header:** CSP với nonce theo từng request (`script-src` không có `unsafe-inline`), HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`.
- **HTTPS:** bản production tự chuyển hướng HTTP → HTTPS. Triển khai sau reverse proxy có TLS và truyền `X-Forwarded-Proto`. Chỉ đặt `FORCE_HTTPS=false` khi thử `npm run build && npm start` trên máy.
- **Dữ liệu vào:** mọi input qua Zod; chỉ truy vấn tham số hóa qua Drizzle; nội dung do người dùng nhập luôn hiển thị dạng văn bản; tệp Excel được kiểm tra đuôi, chữ ký tệp, dung lượng (2 MB) và số dòng (500).
- **Email tài khoản:** chỉ Admin gửi được; nhật ký ghi hành động `account_credentials_sent` nhưng không ghi mật khẩu hay địa chỉ email; log ứng dụng không ghi địa chỉ nhận và nội dung thư.
- **Nhật ký `audit_logs`:** đăng nhập, thay đổi tài khoản, điểm danh, sao, lịch học, đóng lớp, trao quà, cấu hình, xuất báo cáo và mọi thao tác tạo/sửa/xóa.
- **Dữ liệu trẻ em:** GV không nhận số điện thoại, tên phụ huynh, ghi chú của học viên. Log ứng dụng không ghi dữ liệu cá nhân. Tệp sao lưu và tệp xuất có dữ liệu cá nhân: lưu và chia sẻ cẩn thận.

### Rủi ro còn lại (đã biết)

- **Script sao lưu chưa được chạy thử.** `scripts/backup.*` và các lệnh trong `scripts/restore.md` được viết theo tài liệu của `pg_dump`/`pg_restore` và Docker Compose nhưng chưa chạy trên máy phát triển (máy không có Docker). Hãy chạy thử một vòng sao lưu → khôi phục sang CSDL phụ trước khi dựa vào nó.
- **`docker-compose.yml` cũng chưa được chạy thử** vì lý do trên; toàn bộ test chạy trên một PostgreSQL 18 cài tạm, không phải image `postgres:17-alpine`.
- `style-src` cho phép `'unsafe-inline'` vì thư viện giao diện chèn style nội tuyến để định vị hộp thoại. Script vẫn bị khóa chặt bằng nonce.
- Giới hạn tốc độ của Server Action/API lưu trong bộ nhớ tiến trình: chỉ đúng khi chạy một instance. Giới hạn của đăng nhập lưu trong CSDL.
- Giới hạn tốc độ đăng nhập theo IP phụ thuộc header `X-Forwarded-For` do reverse proxy đặt; cần cấu hình proxy không cho client tự gửi header này.
- Nhật ký lưu giá trị cũ/mới của bản ghi nên có chứa dữ liệu cá nhân của học viên; chỉ Admin xem được và chưa có cơ chế tự xóa nhật ký cũ.
- Chưa có chức năng mở lại lớp đã đóng. Nếu đóng nhầm phải sửa trực tiếp trong CSDL.
- `npm audit` (05/10/2026): 15 cảnh báo (6 trung bình, 9 cao), **không có cái nào nằm trên đường chạy production**:
  - `exceljs → uuid` (trung bình): lỗi chỉ ở `uuid` v3/v5/v6 khi truyền bộ đệm; ExcelJS không dùng cách gọi đó.
  - `drizzle-kit → esbuild`, `shadcn`/`eslint-config-next → fast-glob → braces` (trung bình/cao): chỉ là công cụ lúc phát triển, không có trong bản chạy thật. Sửa bằng `npm audit fix --force` sẽ hạ cấp gây lỗi nên chưa áp dụng; cập nhật khi upstream phát hành bản vá.
