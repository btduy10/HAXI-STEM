-- Trang lớp không còn mục "Giáo viên phụ trách": phân công nằm ở lịch mẫu.
-- Dòng lịch mẫu chưa ghi giáo viên (trước đây dùng GV chính của lớp) nay ghi rõ GV chính đó (người có mã đứng đầu nếu lớp có nhiều GV chính),
-- trừ khi người đó đang là trợ giảng của chính dòng ấy. Không xóa dữ liệu nào.
UPDATE "schedule_templates" t
SET "teacher_id" = m."teacher_id"
FROM (
  SELECT DISTINCT ON (ct."class_id") ct."class_id", ct."teacher_id"
  FROM "class_teachers" ct
  INNER JOIN "teachers" te ON te."id" = ct."teacher_id"
  WHERE ct."role" = 'main'
  ORDER BY ct."class_id", te."code"
) m
WHERE t."teacher_id" IS NULL
  AND m."class_id" = t."class_id"
  AND t."assistant_teacher_id" IS DISTINCT FROM m."teacher_id";
