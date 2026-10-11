-- Syllabus chuyển sang ghi theo buổi: Khóa học - Lớp học - Buổi - Tên bài/Chủ đề - Sản phẩm (bỏ Mã môn, Tiết thành Buổi).
-- Chủ hệ thống đã chọn xóa toàn bộ bài Syllabus cũ để nhập lại theo tệp mới. Nội dung các buổi đã điểm danh
-- (sessions.content) không bị đụng tới nên hồ sơ học viên vẫn giữ các bài đã học.
DELETE FROM "syllabus_lessons";--> statement-breakpoint
DROP INDEX "syllabus_lessons_class_subject_period_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "syllabus_lessons_class_period_uq" ON "syllabus_lessons" USING btree ("class_id","period");--> statement-breakpoint
ALTER TABLE "syllabus_lessons" DROP COLUMN "subject_code";