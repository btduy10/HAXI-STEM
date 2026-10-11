-- Lớp không còn gắn với một khóa học (một lớp học lần lượt nhiều khóa; khóa chọn ở Syllabus).
-- 1) Mốc quà đặt theo khóa học: chép thành mốc riêng của từng lớp đang thuộc khóa đó, rồi bỏ mốc theo khóa.
--    Lớp đã có mốc riêng thì trước giờ không dùng mốc của khóa nên không chép. Việc đổi quà và tổng kết của các lớp hiện có không đổi.
INSERT INTO "reward_tiers" ("class_id", "min_stars", "gift_id")
SELECT c."id", t."min_stars", t."gift_id"
FROM "reward_tiers" t
INNER JOIN "classes" c ON c."course_id" = t."course_id"
WHERE t."class_id" IS NULL
  AND c."timetable_only" = false
  AND NOT EXISTS (SELECT 1 FROM "reward_tiers" x WHERE x."class_id" = c."id");--> statement-breakpoint
DELETE FROM "reward_tiers" WHERE "class_id" IS NULL;--> statement-breakpoint
-- 2) Syllabus ghi theo Lớp + Khóa học + Buổi. Chủ hệ thống đã chọn xóa toàn bộ bài Syllabus đang có để nhập lại;
--    tên bài đã ghi ở các buổi đã điểm danh (sessions.content) không bị đụng tới.
DELETE FROM "syllabus_lessons";--> statement-breakpoint
-- 3) Đổi cấu trúc: classes.course_id thôi bắt buộc (giữ cho dữ liệu cũ), syllabus_lessons thêm course_id.
ALTER TABLE "classes" DROP CONSTRAINT "classes_course_id_courses_id_fk";
--> statement-breakpoint
DROP INDEX "syllabus_lessons_class_period_uq";--> statement-breakpoint
ALTER TABLE "classes" ALTER COLUMN "course_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "syllabus_lessons" ADD COLUMN "course_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "classes" ADD CONSTRAINT "classes_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "syllabus_lessons" ADD CONSTRAINT "syllabus_lessons_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "syllabus_lessons_class_course_period_uq" ON "syllabus_lessons" USING btree ("class_id","course_id","period");