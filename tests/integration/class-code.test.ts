import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/db";
import { auditLogs, classes } from "@/db/schema";
import { classInput } from "@/lib/validation/entities";
import * as classSvc from "@/server/services/classes";
import { type Fixture, resetDb, seedFixture } from "./helpers";

// Lớp có sẵn trong dữ liệu thử mang mã cũ nhập tay ("A", "B").
let f: Fixture;
const NOW = new Date("2026-03-10T05:00:00Z");
const input = (name: string, extra: Record<string, unknown> = {}) =>
  classInput.parse({ name, defaultRoomId: "", startDate: "2026-04-01", endDate: "2026-12-31", maxSize: "8", ...extra });

beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
});

describe("mã lớp tự cấp", () => {
  it("RB + năm tạo + số thứ tự; bỏ qua mã cũ; mã và khóa học gửi kèm từ form bị bỏ qua; lớp không gắn khóa", async () => {
    const first = await classSvc.createClass(f.admin, input("RB - T4"), NOW);
    expect(first).toMatchObject({ code: "RB2601", name: "RB - T4", courseId: null, status: "open" });
    const second = await classSvc.createClass(f.admin, input("RB - T7", { code: "TU-DAT", courseId: f.course.id }), NOW);
    expect(second).toMatchObject({ code: "RB2602", courseId: null });
    // Sang năm sau đếm lại từ đầu; theo năm tạo lớp, không theo ngày bắt đầu.
    expect((await classSvc.createClass(f.admin, input("Lớp năm sau"), new Date("2027-01-02T05:00:00Z"))).code).toBe("RB2701");
    expect((await classSvc.createClass(f.admin, input("Lớp khai giảng 2027", { startDate: "2027-01-05", endDate: "2027-06-30" }), NOW)).code).toBe("RB2603");

    const [log] = await db.select().from(auditLogs).where(eq(auditLogs.recordId, first.id));
    expect(log).toMatchObject({ action: "create", tableName: "classes", userId: f.admin.userId });
    // Danh sách lớp không còn thông tin khóa học.
    const listed = (await classSvc.listClasses(f.admin)).find((c) => c.id === first.id)!;
    expect(listed).toMatchObject({ code: "RB2601", name: "RB - T4" });
    expect(listed).not.toHaveProperty("courseName");
  });

  it("hai người thêm lớp cùng lúc không nhận trùng mã; sửa lớp không đổi mã; cần quyền Thêm của menu Lớp học", async () => {
    const made = await Promise.all(["Một", "Hai", "Ba"].map((name) => classSvc.createClass(f.admin, input(`Lớp ${name}`), NOW)));
    expect(made.map((c) => c.code).sort()).toEqual(["RB2601", "RB2602", "RB2603"]);

    await classSvc.updateClass(f.admin, made[0]!.id, input("Lớp Một đổi tên", { code: "DOI-MA" }));
    const [after] = await db.select().from(classes).where(eq(classes.id, made[0]!.id));
    expect(after).toMatchObject({ code: made[0]!.code, name: "Lớp Một đổi tên" });
    // Lớp cũ giữ mã cũ khi sửa.
    await classSvc.updateClass(f.admin, f.classA.id, input("Lớp A", { startDate: f.classA.startDate, endDate: f.classA.endDate, maxSize: "3" }));
    expect((await db.select().from(classes).where(eq(classes.id, f.classA.id)))[0]!.code).toBe("A");

    await expect(classSvc.createClass(f.actorA, input("Giáo viên tự tạo"), NOW)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db.select().from(classes)).toHaveLength(5);
  });
});
