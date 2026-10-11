import { and, asc, count, eq, ilike, inArray, like, or, sql } from "drizzle-orm";
import type { z } from "zod";
import { db, type DbOrTx, type Tx } from "@/db";
import { classes, enrollments, students } from "@/db/schema";
import { nextStudentCode, studentCodeYearPrefix } from "@/domain/student-code";
import { todayIso } from "@/lib/format";
import type { studentInput } from "@/lib/validation/entities";
import { audit } from "../audit";
import { notFound } from "../errors";
import { type Actor, allowedClassIds, assertCan, assertClassAccess, isAdmin, seesAllClasses, seesStudentPrivate } from "../guard";
import { updateRow } from "./crud";

type StudentRow = typeof students.$inferSelect;

/** Thông tin cá nhân: chỉ Admin và vai trò được tick "Thông tin cá nhân học viên" được xem và sửa; vai trò khác luôn nhận giá trị rỗng. */
const PRIVATE_FIELDS = ["birthDate", "gender", "guardianName", "phone", "note"] as const;
const hidePrivate = (row: StudentRow): StudentRow => ({ ...row, birthDate: null, gender: null, guardianName: null, phone: null, note: null });
const forActor = (actor: Actor, rows: StudentRow[]) => (seesStudentPrivate(actor) ? rows : rows.map(hidePrivate));

const searchFilter = (search?: string) => {
  const term = search?.trim();
  const pattern = term ? `%${term.replace(/[%_\\]/g, "\\$&")}%` : null;
  return pattern ? or(ilike(students.fullName, pattern), ilike(students.code, pattern)) : undefined;
};

/** Học viên đã từng ghi danh một lớp trong phạm vi của người dùng. undefined = không giới hạn. */
async function scopeFilter(actor: Actor) {
  const allowed = await allowedClassIds(actor);
  if (allowed === null) return undefined;
  if (allowed.length === 0) return sql`false`;
  return inArray(students.id, db.select({ id: enrollments.studentId }).from(enrollments).where(inArray(enrollments.classId, allowed)));
}

/**
 * Toàn bộ học viên, dùng cho ô chọn khi ghi danh (học viên mới chưa thuộc lớp nào cũng phải chọn được).
 * Cần quyền Thêm ở menu Ghi danh; không được xem thông tin cá nhân thì chỉ nhận mã, tên, khối, trạng thái.
 */
export async function listStudents(actor: Actor, search?: string) {
  assertCan(actor, "enrollments", "add");
  return forActor(actor, await db.select().from(students).where(searchFilter(search)).orderBy(asc(students.code)));
}

export const STUDENT_PAGE_SIZE = 10;

/** Danh sách học viên theo trang (mỗi trang 10 em). Trang vượt quá số trang thì trả về trang cuối. */
export async function listStudentsPage(actor: Actor, search: string | undefined, page: number) {
  assertCan(actor, "students", "view");
  const where = and(searchFilter(search), await scopeFilter(actor));
  const [counted] = await db.select({ n: count() }).from(students).where(where);
  const total = counted?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / STUDENT_PAGE_SIZE));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  const rows = await db
    .select()
    .from(students)
    .where(where)
    .orderBy(asc(students.code))
    .limit(STUDENT_PAGE_SIZE)
    .offset((current - 1) * STUDENT_PAGE_SIZE);
  return { rows: forActor(actor, rows), total, page: current, pageCount, pageSize: STUDENT_PAGE_SIZE };
}

export async function getStudent(actor: Actor, id: string) {
  assertCan(actor, "students", "view");
  const [row] = await db.select().from(students).where(and(eq(students.id, id), await scopeFilter(actor))).limit(1);
  if (!row) throw notFound("học viên");
  return forActor(actor, [row])[0]!;
}

/** Mã học viên tự cấp kế tiếp của năm hiện tại (HX2601, HX2602, …). */
export async function suggestStudentCode(tx: DbOrTx = db, now: Date = new Date()): Promise<string> {
  const year = Number(todayIso(now).slice(0, 4));
  const rows = await tx.select({ code: students.code }).from(students).where(like(students.code, `${studentCodeYearPrefix(year)}%`));
  return nextStudentCode(rows.map((r) => r.code), year);
}

/**
 * Thêm học viên trong một giao dịch có sẵn (người gọi đã kiểm tra quyền Thêm của menu Ghi danh).
 * Mã luôn do máy chủ cấp (mã kế tiếp của năm); không được xem thông tin cá nhân thì các ô đó không được ghi qua form.
 */
export async function insertStudent(
  tx: Tx,
  actor: Actor,
  data: Omit<z.output<typeof studentInput>, "code">,
  now: Date = new Date(),
): Promise<StudentRow> {
  const values = seesStudentPrivate(actor) ? data : { ...data, birthDate: null, gender: null, guardianName: null, phone: null, note: null };
  // Hai người thêm cùng lúc không nhận trùng một mã tự cấp.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('student_code'))`);
  const code = await suggestStudentCode(tx, now);
  const [row] = await tx.insert(students).values({ ...values, code }).returning();
  await audit(tx, { userId: actor.userId, action: "create", tableName: "students", recordId: row!.id, newValue: row });
  return row!;
}

/**
 * Danh sách chờ lớp: học viên đang học mà chưa có ghi danh hiệu lực ở lớp đang mở nào.
 * Chỉ người thấy mọi lớp mới có danh sách này (phạm vi "lớp của mình" không thấy học viên chưa thuộc lớp nào).
 */
export async function listWaitingStudents(actor: Actor) {
  assertCan(actor, "enrollments", "view");
  if (!seesAllClasses(actor)) return [];
  return db
    .select({ id: students.id, code: students.code, fullName: students.fullName, schoolGrade: students.schoolGrade, createdAt: students.createdAt })
    .from(students)
    .where(
      and(
        eq(students.status, "active"),
        sql`not exists (
          select 1 from ${enrollments}
          inner join ${classes} on ${classes.id} = ${enrollments.classId}
          where ${enrollments.studentId} = ${students.id} and ${enrollments.status} = 'active' and ${classes.status} = 'open'
        )`,
      ),
    )
    .orderBy(asc(students.createdAt), asc(students.code));
}

export async function updateStudent(actor: Actor, id: string, data: z.output<typeof studentInput>) {
  assertCan(actor, "students", "edit");
  if (!isAdmin(actor)) {
    // Chỉ sửa được học viên trong phạm vi lớp của mình.
    const [inScope] = await db.select({ id: students.id }).from(students).where(and(eq(students.id, id), await scopeFilter(actor))).limit(1);
    if (!inScope) throw notFound("học viên");
  }
  if (seesStudentPrivate(actor)) return updateRow(actor, students, "students", id, data, "students");
  // Không được xem thông tin cá nhân: giữ nguyên các ô đó đang lưu.
  const patch: Partial<typeof data> = { ...data };
  for (const field of PRIVATE_FIELDS) delete patch[field];
  return hidePrivate(await updateRow(actor, students, "students", id, patch, "students"));
}

/**
 * Học viên đang ghi danh của một lớp. GV chỉ xem được lớp mình và chỉ nhận
 * các trường tối thiểu (không có số điện thoại, phụ huynh, ghi chú).
 */
export async function listClassStudents(actor: Actor, classId: string) {
  await assertClassAccess(actor, classId);
  return db
    .select({
      id: students.id,
      code: students.code,
      fullName: students.fullName,
      schoolGrade: students.schoolGrade,
      status: students.status,
      joinedAt: enrollments.joinedAt,
    })
    .from(enrollments)
    .innerJoin(students, eq(students.id, enrollments.studentId))
    .where(and(eq(enrollments.classId, classId), eq(enrollments.status, "active")))
    .orderBy(asc(students.fullName));
}
