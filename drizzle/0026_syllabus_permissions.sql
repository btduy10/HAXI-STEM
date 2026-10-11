-- Giáo viên tự soạn Syllabus của lớp mình: Xem, Thêm, Sửa, Xóa (ô tick Xóa mới chỉ có ở menu Syllabus).
-- Bảng phân quyền đã lưu (Cấu hình → Phân quyền) đè lên mặc định nên cập nhật trực tiếp đúng ô này của vai trò Giáo viên;
-- các ô khác và các vai trò khác giữ nguyên. Chưa lưu bảng phân quyền lần nào hoặc thiếu vai trò thì không làm gì.
UPDATE "app_settings"
SET "value" = jsonb_set("value", '{teacher,menus,syllabus}', '{"view": true, "add": true, "edit": true, "delete": true}'::jsonb),
    "updated_at" = now()
WHERE "key" = 'role_permissions' AND jsonb_typeof("value" #> '{teacher,menus}') = 'object';
