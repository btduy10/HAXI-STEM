-- Buổi học sinh theo từng tuần (chỉ tuần sau), không sinh sẵn tới ngày kết thúc của lớp.
-- Theo quyết định của chủ hệ thống: bỏ các buổi thường CHƯA DẠY đã sinh sẵn có ngày sau Chủ nhật tuần sau (tính theo ngày Việt Nam lúc chạy),
-- kể cả buổi đã sửa tay. Giữ: buổi đã dạy, đã hủy, buổi bù, buổi đã điểm danh, đã ghi sao, đã có em được xếp học bù, đã chỉnh chấm công.
DELETE FROM "sessions" s
WHERE s."kind" = 'regular'
  AND s."status" = 'planned'
  AND s."date" > (date_trunc('week', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 13)
  AND NOT EXISTS (SELECT 1 FROM "attendances" a WHERE a."session_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "star_logs" l WHERE l."session_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "makeup_assignments" m WHERE m."makeup_session_id" = s."id" OR m."absent_session_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "session_students" x WHERE x."session_id" = s."id")
  AND NOT EXISTS (SELECT 1 FROM "timesheet_overrides" o WHERE o."session_id" = s."id");
