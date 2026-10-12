import { z } from "zod";
import { id } from "./common";

// Đầu vào của các hàm đọc chi tiết trên dashboard 3D (trang Tổng quan).
export const centerSessionInput = z.object({ sessionId: id });
export const centerStudentInput = z.object({ studentId: id });
export const centerTeacherInput = z.object({ teacherId: id });
export const centerSearchInput = z.object({ query: z.string().trim().min(2, "Nhập ít nhất 2 ký tự").max(60, "Tối đa 60 ký tự") });
