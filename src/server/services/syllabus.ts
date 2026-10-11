import ExcelJS from "exceljs";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { z } from "zod";
import { db } from "@/db";
import { classes, courses, syllabusLessons } from "@/db/schema";
import { SYLLABUS_COLUMNS, type SyllabusKey, type SyllabusRowResult, validateSyllabusRows } from "@/domain/syllabus-import";
import type { syllabusEdit, syllabusInput } from "@/lib/validation/entities";
import { audit } from "../audit";
import { AppError, notFound, translateDbError } from "../errors";
import { type Actor, allowedClassIds, assertCan, assertClassAccess, assertNotTimetableOnly, can } from "../guard";
import { type ImportUpload, assertXlsxUpload, parseWorkbook } from "./import";

// Syllabus: chương trình dạy theo Lớp + Khóa học + Buổi (Tên bài/Chủ đề + Sản phẩm). Lớp chọn từ menu Lớp học, khóa chọn từ
// menu Khóa học; một lớp học lần lượt nhiều khóa. Giáo viên chọn tên bài khi điểm danh.
// Quyền theo Cấu hình → Phân quyền (Xem / Thêm / Sửa / Xóa) và phạm vi lớp của người dùng.

const DUPLICATE = "Lớp này đã có bài ở Buổi đó của khóa học này.";

/** Bài học trong phạm vi lớp của người xem, sắp theo khóa học → lớp → buổi (Buổi 1 trước). */
export async function listSyllabus(actor: Actor, filters: { courseId?: string | null; classId?: string | null } = {}) {
  assertCan(actor, "syllabus", "view");
  const allowed = await allowedClassIds(actor);
  if (allowed && allowed.length === 0) return [];
  const conditions = [];
  if (allowed) conditions.push(inArray(syllabusLessons.classId, allowed));
  if (filters.courseId) conditions.push(eq(syllabusLessons.courseId, filters.courseId));
  if (filters.classId) conditions.push(eq(syllabusLessons.classId, filters.classId));
  return db
    .select({
      id: syllabusLessons.id,
      classId: syllabusLessons.classId,
      classCode: classes.code,
      className: classes.name,
      courseId: courses.id,
      courseName: courses.name,
      period: syllabusLessons.period,
      title: syllabusLessons.title,
      product: syllabusLessons.product,
    })
    .from(syllabusLessons)
    .innerJoin(classes, eq(classes.id, syllabusLessons.classId))
    .innerJoin(courses, eq(courses.id, syllabusLessons.courseId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(courses.name), asc(classes.name), asc(classes.code), asc(syllabusLessons.period));
}

/**
 * Bài học của một lớp để chọn khi điểm danh, theo khóa học rồi theo buổi. Không kiểm tra quyền menu Syllabus:
 * nơi gọi đã bảo đảm người dùng vào được buổi học của lớp này.
 */
export async function lessonsForClass(classId: string) {
  return db
    .select({ courseName: courses.name, period: syllabusLessons.period, title: syllabusLessons.title })
    .from(syllabusLessons)
    .innerJoin(courses, eq(courses.id, syllabusLessons.courseId))
    .where(eq(syllabusLessons.classId, classId))
    .orderBy(asc(courses.name), asc(syllabusLessons.period));
}

async function assertNoDuplicate(lesson: { classId: string; courseId: string; period: number }, exceptId?: string) {
  const [dup] = await db
    .select({ id: syllabusLessons.id })
    .from(syllabusLessons)
    .where(and(eq(syllabusLessons.classId, lesson.classId), eq(syllabusLessons.courseId, lesson.courseId), eq(syllabusLessons.period, lesson.period)))
    .limit(1);
  if (dup && dup.id !== exceptId) throw new AppError("VALIDATION", DUPLICATE, { period: DUPLICATE });
}

export async function createLesson(actor: Actor, data: z.output<typeof syllabusInput>) {
  assertCan(actor, "syllabus", "add");
  await assertClassAccess(actor, data.classId);
  await assertNotTimetableOnly(data.classId);
  const [course] = await db.select({ id: courses.id }).from(courses).where(eq(courses.id, data.courseId)).limit(1);
  if (!course) throw notFound("khóa học");
  await assertNoDuplicate(data);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx.insert(syllabusLessons).values(data).returning();
      await audit(tx, { userId: actor.userId, action: "create", tableName: "syllabus_lessons", recordId: row!.id, newValue: row });
      return row!;
    });
  } catch (e) {
    throw translateDbError(e);
  }
}

/** Sửa buổi, tên bài, sản phẩm của một bài; lớp và khóa học của bài giữ nguyên. */
export async function updateLesson(actor: Actor, id: string, data: z.output<typeof syllabusEdit>) {
  assertCan(actor, "syllabus", "edit");
  const [before] = await db.select().from(syllabusLessons).where(eq(syllabusLessons.id, id)).limit(1);
  if (!before) throw notFound("bài học");
  await assertClassAccess(actor, before.classId);
  await assertNoDuplicate({ classId: before.classId, courseId: before.courseId, period: data.period }, id);
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .update(syllabusLessons)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(syllabusLessons.id, id))
        .returning();
      await audit(tx, { userId: actor.userId, action: "update", tableName: "syllabus_lessons", recordId: id, oldValue: before, newValue: row });
      return row!;
    });
  } catch (e) {
    throw translateDbError(e);
  }
}

/** Xóa một bài: cần ô tick Xóa của menu Syllabus và bài phải thuộc lớp trong phạm vi của người dùng. */
export async function deleteLesson(actor: Actor, id: string) {
  assertCan(actor, "syllabus", "delete");
  await db.transaction(async (tx) => {
    const [before] = await tx.select().from(syllabusLessons).where(eq(syllabusLessons.id, id)).limit(1);
    if (!before) throw notFound("bài học");
    await assertClassAccess(actor, before.classId, tx);
    await tx.delete(syllabusLessons).where(eq(syllabusLessons.id, id));
    await audit(tx, { userId: actor.userId, action: "delete", tableName: "syllabus_lessons", recordId: id, oldValue: before });
  });
}

// ---------- Nhập từ Excel (ai có quyền Thêm của menu Syllabus; chỉ ghi vào lớp trong phạm vi của mình) ----------

export type SyllabusPreview = { rows: SyllabusRowResult[]; validCount: number; errorCount: number };

/** Các lớp người dùng được ghi Syllabus (trong phạm vi, không gồm lớp chỉ hiển thị trên Thời khóa biểu). */
async function writableClasses(actor: Actor) {
  const allowed = await allowedClassIds(actor);
  if (allowed && allowed.length === 0) return [];
  return db
    .select({ id: classes.id, code: classes.code, name: classes.name })
    .from(classes)
    .where(and(eq(classes.timetableOnly, false), allowed ? inArray(classes.id, allowed) : undefined))
    .orderBy(asc(classes.name), asc(classes.code));
}

const lessonKey = (lesson: { classId: string; courseId: string; period: number }) => `${lesson.classId}|${lesson.courseId}|${lesson.period}`;

export async function previewSyllabusImport(actor: Actor, file: ImportUpload): Promise<SyllabusPreview> {
  assertCan(actor, "syllabus", "add");
  assertXlsxUpload(file);
  const raw = await parseWorkbook<SyllabusKey>(
    file.bytes,
    SYLLABUS_COLUMNS,
    SYLLABUS_COLUMNS.filter((c) => c.key !== "product").map((c) => c.key),
    'Dòng tiêu đề phải có các cột "Khóa học", "Lớp học", "Buổi", "Tên bài/Chủ đề" (cột "Sản phẩm" để trống được). Hãy dùng tệp mẫu.',
  );
  const [writable, allCourses] = await Promise.all([writableClasses(actor), db.select({ id: courses.id, name: courses.name }).from(courses)]);
  let rows = validateSyllabusRows(raw, writable, allCourses);

  // Bài đã có cùng Lớp + Khóa + Buổi sẽ được cập nhật: cần quyền Sửa.
  if (!can(actor, "syllabus", "edit")) {
    const classIds = [...new Set(rows.flatMap((r) => (r.data ? [r.data.classId] : [])))];
    const existing = classIds.length
      ? await db
          .select({ classId: syllabusLessons.classId, courseId: syllabusLessons.courseId, period: syllabusLessons.period })
          .from(syllabusLessons)
          .where(inArray(syllabusLessons.classId, classIds))
      : [];
    const have = new Set(existing.map(lessonKey));
    rows = rows.map((r) =>
      r.data && have.has(lessonKey(r.data))
        ? { ...r, data: null, errors: ["Lớp này đã có bài ở Buổi đó của khóa học này; cần quyền Sửa của Syllabus để cập nhật"] }
        : r,
    );
  }
  const validCount = rows.filter((r) => r.data).length;
  return { rows, validCount, errorCount: rows.length - validCount };
}

/** Ghi các dòng hợp lệ: đã có cùng Lớp + Khóa + Buổi thì cập nhật tên bài và sản phẩm, chưa có thì thêm. Dòng lỗi bị bỏ qua. */
export async function commitSyllabusImport(actor: Actor, file: ImportUpload): Promise<SyllabusPreview & { inserted: number; updated: number }> {
  const preview = await previewSyllabusImport(actor, file);
  const valid = preview.rows.flatMap((r) => (r.data ? [r.data] : []));
  if (valid.length === 0) throw new AppError("VALIDATION", "Không có dòng hợp lệ nào để nhập.");
  let inserted = 0;
  let updated = 0;
  try {
    await db.transaction(async (tx) => {
      const existing = await tx
        .select({ classId: syllabusLessons.classId, courseId: syllabusLessons.courseId, period: syllabusLessons.period })
        .from(syllabusLessons)
        .where(inArray(syllabusLessons.classId, [...new Set(valid.map((v) => v.classId))]));
      const have = new Set(existing.map(lessonKey));
      for (const row of valid) {
        if (have.has(lessonKey(row))) updated++;
        else inserted++;
        await tx
          .insert(syllabusLessons)
          .values(row)
          .onConflictDoUpdate({
            target: [syllabusLessons.classId, syllabusLessons.courseId, syllabusLessons.period],
            set: { title: row.title, product: row.product, updatedAt: new Date() },
          });
      }
      await audit(tx, { userId: actor.userId, action: "import", tableName: "syllabus_lessons", newValue: { inserted, updated } });
    });
  } catch (e) {
    throw translateDbError(e);
  }
  return { ...preview, inserted, updated };
}

/** Tệp mẫu nhập Syllabus; điền sẵn tên một khóa và một lớp có thật mà người dùng được ghi để dễ làm theo. */
export async function buildSyllabusTemplate(actor: Actor): Promise<Uint8Array> {
  assertCan(actor, "syllabus", "add");
  const [writable, [course]] = await Promise.all([writableClasses(actor), db.select({ name: courses.name }).from(courses).orderBy(asc(courses.name)).limit(1)]);
  const courseName = course?.name ?? "TÊN KHÓA HỌC";
  // Lớp trùng tên với lớp khác thì ghi mã để tệp mẫu luôn nhập lại được.
  const sample = writable[0];
  const className = sample ? (writable.filter((c) => c.name.trim().toLowerCase() === sample.name.trim().toLowerCase()).length > 1 ? sample.code : sample.name) : "TÊN LỚP";
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Syllabus");
  sheet.columns = SYLLABUS_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.key === "title" || c.key === "product" ? 40 : c.key === "period" ? 10 : 26 }));
  sheet.getRow(1).font = { bold: true };
  sheet.addRow({ courseName, className, period: 1, title: "Làm quen với robot", product: "Robot chào hỏi" });
  sheet.addRow({ courseName, className, period: 2, title: "Lắp ráp khung xe", product: "Khung xe hai bánh" });
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
