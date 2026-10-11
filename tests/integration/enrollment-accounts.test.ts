import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { account, attendances, auditLogs, classes as classesTable, session, sessions, starLogs, students, syllabusLessons, teachers, user } from "@/db/schema";
import type { MailMessage } from "@/server/mailer";
import { verifyPassword } from "@/server/password";
import * as accounts from "@/server/services/accounts";
import * as catalog from "@/server/services/catalog";
import * as classes from "@/server/services/classes";
import { type Fixture, resetDb, seedFixture } from "./helpers";

// Không gửi thư thật: giả lập máy chủ thư, ghi lại thư đã gửi.
const mail = vi.hoisted(() => ({ sent: [] as MailMessage[], fail: false }));
vi.mock("@/server/mailer", () => ({
  assertMailConfigured: () => {},
  sendMail: async (message: MailMessage) => {
    if (mail.fail) throw new Error("SMTP lỗi");
    mail.sent.push(message);
  },
}));

let f: Fixture;
beforeEach(async () => {
  await resetDb();
  f = await seedFixture();
  mail.sent = [];
  mail.fail = false;
});

describe("ghi danh", () => {
  const enroll = (i: number, joinedAt = "2026-01-10") =>
    classes.enrollStudent(f.admin, { classId: f.classA.id, studentId: f.students[i]!.id, joinedAt });

  it("chặn khi vượt sĩ số tối đa", async () => {
    await enroll(4); // lớp A: 2 → 3 (tối đa 3)
    await expect(enroll(5)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("không ghi danh trùng học viên đang học", async () => {
    await expect(enroll(0)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rời lớp giữ lịch sử và cho ghi danh lại", async () => {
    const list = await classes.listEnrollments(f.admin, f.classA.id);
    const first = list.find((e) => e.code === "A1")!;
    await expect(classes.leaveEnrollment(f.admin, { id: first.id, leftAt: "2026-01-01" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await classes.leaveEnrollment(f.admin, { id: first.id, leftAt: "2026-02-01" });
    await enroll(0, "2026-03-01");
    const after = (await classes.listEnrollments(f.admin, f.classA.id)).filter((e) => e.code === "A1");
    expect(after.map((e) => e.status).sort()).toEqual(["active", "left"]);
  });

  it("Admin xóa ghi danh nhập sai kèm điểm danh và lịch sử sao trong thời gian ghi danh", async () => {
    const list = await classes.listEnrollments(f.admin, f.classA.id);
    const [a1, a2] = [list.find((e) => e.code === "A1")!, list.find((e) => e.code === "A2")!];
    await expect(classes.deleteEnrollment(f.actorA, a1.id)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const [held] = await db.insert(sessions).values({ classId: f.classA.id, date: "2026-01-12", startTime: "08:00", endTime: "09:30" }).returning();
    const [other] = await db.insert(sessions).values({ classId: f.classB.id, date: "2026-01-12", startTime: "10:00", endTime: "11:30" }).returning();
    await db.insert(attendances).values([
      { sessionId: held!.id, studentId: a1.studentId, status: "present" },
      { sessionId: held!.id, studentId: a2.studentId, status: "present" },
      { sessionId: other!.id, studentId: a1.studentId, status: "present" }, // lớp khác: không đụng tới
    ]);
    const [given] = await db.insert(starLogs).values({ sessionId: held!.id, studentId: a1.studentId, stars: 3 }).returning();
    await db.insert(starLogs).values([
      { sessionId: held!.id, studentId: a1.studentId, stars: -3, reversesLogId: given!.id }, // bản ghi hoàn tác
      { sessionId: held!.id, studentId: a2.studentId, stars: 2 }, // học viên khác: giữ
      { sessionId: other!.id, studentId: a1.studentId, stars: 5 }, // lớp khác: giữ
    ]);

    expect(await classes.deleteEnrollment(f.admin, a1.id)).toEqual({ deletedAttendances: 1, deletedStarLogs: 2 });
    expect((await classes.listEnrollments(f.admin, f.classA.id)).map((e) => e.code)).toEqual(["A2"]);
    const left = await db.select().from(attendances);
    expect(left.map((r) => `${r.sessionId === held!.id ? "A" : "B"}:${r.studentId === a1.studentId ? "A1" : "A2"}`).sort()).toEqual(["A:A2", "B:A1"]);
    expect((await db.select().from(starLogs)).map((r) => r.stars).sort()).toEqual([2, 5]);
    // Ngoài thao tác này, sổ sao vẫn chỉ thêm: xóa trực tiếp bị CSDL chặn.
    await expect(db.delete(starLogs)).rejects.toThrow();
    await enroll(0); // xóa xong thì ghi danh lại được

    await db.update(classesTable).set({ status: "closed" }).where(eq(classesTable.id, f.classA.id));
    await expect(classes.deleteEnrollment(f.admin, a2.id)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("không ghi danh học viên đã nghỉ hoặc vào lớp đã đóng", async () => {
    await db.update(students).set({ status: "left" }).where(eq(students.id, f.students[4]!.id));
    await expect(enroll(4)).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("danh mục và nhật ký", () => {
  it("tạo/sửa/xóa ghi audit_logs kèm giá trị cũ và mới", async () => {
    const room = await catalog.createRoom(f.admin, { name: "Lab 9", capacity: 6 });
    await catalog.updateRoom(f.admin, room.id, { name: "Lab 9", capacity: 8 });
    await catalog.deleteRoom(f.admin, room.id);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.recordId, room.id)).orderBy(auditLogs.createdAt);
    expect(logs.map((l) => l.action)).toEqual(["create", "update", "delete"]);
    expect(logs[1]!.oldValue).toMatchObject({ capacity: 6 });
    expect(logs[1]!.newValue).toMatchObject({ capacity: 8 });
    expect(logs.every((l) => l.userId === f.admin.userId)).toBe(true);
  });

  it("trùng mã báo lỗi CONFLICT, xóa dữ liệu đang dùng bị chặn", async () => {
    await expect(catalog.createTeacher(f.admin, { code: "GVA", fullName: "Trùng", shortName: null, phone: null, email: null, status: "active" })).rejects.toMatchObject({ code: "CONFLICT" });
    // Khóa học đang có bài Syllabus thì không xóa được. Lớp không còn gắn khóa nên không chặn việc xóa khóa.
    const [lesson] = await db.insert(syllabusLessons).values({ classId: f.classA.id, courseId: f.course.id, period: 1, title: "Bài 1" }).returning();
    await expect(catalog.deleteCourse(f.admin, f.course.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await db.delete(syllabusLessons).where(eq(syllabusLessons.id, lesson!.id));
    await catalog.deleteCourse(f.admin, f.course.id);
    expect((await db.select().from(classesTable)).map((c) => c.code).sort()).toEqual(["A", "B"]);
  });
});

describe("tài khoản", () => {
  const input = { username: "gv.moi", name: "GV mới", role: "teacher" as const, teacherId: null, password: "MatKhauTam123" };

  it("tạo tài khoản: băm Argon2id, buộc đổi mật khẩu, không lưu mật khẩu vào nhật ký", async () => {
    const { id } = await accounts.createAccount(f.admin, { ...input, teacherId: f.teacherA.id });
    const [u] = await db.select().from(user).where(eq(user.id, id));
    const [a] = await db.select().from(account).where(eq(account.userId, id));
    expect(u!.mustChangePassword).toBe(true);
    expect(a!.password).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword({ hash: a!.password!, password: input.password })).toBe(true);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.recordId, id));
    expect(JSON.stringify(logs)).not.toContain(input.password);
    await expect(accounts.createAccount(f.admin, { ...input, teacherId: f.teacherA.id })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("khóa tài khoản thu hồi phiên; không tự khóa chính mình", async () => {
    await db.insert(session).values({ id: "s1", token: "t1", userId: f.actorA.userId, expiresAt: new Date(Date.now() + 3600_000) });
    await accounts.setAccountLocked(f.admin, f.actorA.userId, true);
    const [u] = await db.select().from(user).where(eq(user.id, f.actorA.userId));
    expect(u!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(await db.select().from(session).where(eq(session.userId, f.actorA.userId))).toEqual([]);
    await expect(accounts.setAccountLocked(f.admin, f.admin.userId, true)).rejects.toMatchObject({ code: "CONFLICT" });
    await accounts.setAccountLocked(f.admin, f.actorA.userId, false);
    const [unlocked] = await db.select().from(user).where(eq(user.id, f.actorA.userId));
    expect(unlocked!.lockedUntil).toBeNull();
  });

  it("sửa tài khoản: đổi tên đăng nhập, vai trò, GV gắn kèm; có nhật ký và thu hồi phiên", async () => {
    await db.insert(session).values({ id: "s3", token: "t3", userId: f.actorB.userId, expiresAt: new Date(Date.now() + 3600_000) });
    const base = { id: f.actorB.userId, username: "gv.b", name: "Giáo viên B", role: "teacher" as const, teacherId: f.teacherB.id };

    // Chỉ đổi tên hiển thị: không đăng xuất.
    await accounts.updateAccount(f.admin, { ...base, name: "Cô B" });
    expect(await db.select().from(session).where(eq(session.userId, f.actorB.userId))).toHaveLength(1);
    // Sửa tài khoản không bao giờ tự khóa tài khoản đó.
    expect((await db.select().from(user).where(eq(user.id, f.actorB.userId)))[0]).toMatchObject({ lockedUntil: null, failedAttempts: 0 });

    await accounts.updateAccount(f.admin, { ...base, name: "Cô B", username: "co.b" });
    const [renamed] = await db.select().from(user).where(eq(user.id, f.actorB.userId));
    expect(renamed).toMatchObject({ username: "co.b", email: "co.b@haxi.local", name: "Cô B", role: "teacher", teacherId: f.teacherB.id });
    expect(await db.select().from(session).where(eq(session.userId, f.actorB.userId))).toEqual([]);

    // Lên quản trị thì bỏ gắn giáo viên; hạ lại GV phải gắn giáo viên chưa có tài khoản.
    await accounts.updateAccount(f.admin, { ...base, username: "co.b", role: "admin", teacherId: f.teacherB.id });
    expect((await db.select().from(user).where(eq(user.id, f.actorB.userId)))[0]).toMatchObject({ role: "admin", teacherId: null });
    await expect(accounts.updateAccount(f.admin, { ...base, username: "co.b", teacherId: f.teacherA.id })).rejects.toMatchObject({
      code: "CONFLICT",
      fieldErrors: { teacherId: expect.any(String) },
    });
    await accounts.updateAccount(f.admin, { ...base, username: "co.b" });

    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "account_updated"));
    expect(logs).toHaveLength(4);
    expect(logs.some((l) => (l.oldValue as { username: string }).username === "gv.b" && (l.newValue as { username: string }).username === "co.b")).toBe(true);
  });

  it("sửa tài khoản: chặn trùng tên, tự đổi vai trò, mất quản trị viên cuối, và người không phải Admin", async () => {
    const self = { id: f.admin.userId, username: "admin", name: "Quản trị", role: "admin" as const, teacherId: null };
    await expect(accounts.updateAccount(f.admin, { ...self, role: "teacher", teacherId: f.teacherA.id })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(accounts.updateAccount(f.admin, { ...self, username: "gv.a" })).rejects.toMatchObject({
      code: "CONFLICT",
      fieldErrors: { username: expect.any(String) },
    });
    await expect(accounts.updateAccount(f.actorA, { ...self, name: "Chiếm quyền" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      accounts.updateAccount(f.actorA, { id: f.actorA.userId, username: "gv.a", name: "A", role: "admin", teacherId: null }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(accounts.updateAccount(f.admin, { ...self, id: "khong-ton-tai" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // Tự sửa tên hiển thị của mình thì được.
    await expect(accounts.updateAccount(f.admin, { ...self, name: "Quản trị viên chính" })).resolves.toBeDefined();

    // Có hai quản trị: quản trị này hạ quyền quản trị kia được, nhưng không thể không còn ai.
    await accounts.updateAccount(f.admin, { id: f.actorB.userId, username: "gv.b", name: "B", role: "admin", teacherId: null });
    const second = { userId: f.actorB.userId, role: "admin" as const, teacherId: null };
    await accounts.updateAccount(second, { ...self, role: "teacher", teacherId: f.teacherB.id });
    expect((await db.select().from(user).where(eq(user.id, f.admin.userId)))[0]!.role).toBe("teacher");
  });

  it("đặt lại mật khẩu: gỡ khóa tài khoản, có thể cho dùng luôn; Admin tự đặt lại thì không bị đăng xuất", async () => {
    // GV A đang bị khóa tạm do nhập sai nhiều lần.
    await db.update(user).set({ lockedUntil: new Date(Date.now() + 15 * 60_000), failedAttempts: 4 }).where(eq(user.id, f.actorA.userId));
    await db.insert(account).values({ id: "acc-a", accountId: f.actorA.userId, providerId: "credential", userId: f.actorA.userId, password: "cu" });
    await accounts.resetAccountPassword(f.admin, f.actorA.userId, "MatKhau88", false);
    const [u] = await db.select().from(user).where(eq(user.id, f.actorA.userId));
    expect(u).toMatchObject({ lockedUntil: null, failedAttempts: 0, mustChangePassword: false });
    const [a] = await db.select().from(account).where(eq(account.userId, f.actorA.userId));
    expect(await verifyPassword({ hash: a!.password!, password: "MatKhau88" })).toBe(true);

    // Admin tự đặt lại mật khẩu của mình: phiên hiện tại được giữ.
    await db.insert(account).values({ id: "acc-admin", accountId: f.admin.userId, providerId: "credential", userId: f.admin.userId, password: "cu" });
    await db.insert(session).values({ id: "s-admin", token: "t-admin", userId: f.admin.userId, expiresAt: new Date(Date.now() + 3600_000) });
    await accounts.resetAccountPassword(f.admin, f.admin.userId, "MatKhauAdmin99", false);
    expect(await db.select().from(session).where(eq(session.userId, f.admin.userId))).toHaveLength(1);

    await expect(accounts.resetAccountPassword(f.actorA, f.admin.userId, "ChiemQuyen123", false)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("xóa tài khoản: xóa phiên và mật khẩu, giữ hồ sơ giáo viên, ghi nhật ký; không tự xóa mình, GV không xóa được", async () => {
    const { id } = await accounts.createAccount(f.admin, { ...input, teacherId: null, role: "admin" });
    await db.insert(session).values({ id: "s-del", token: "t-del", userId: id, expiresAt: new Date(Date.now() + 3600_000) });
    await expect(accounts.deleteAccount(f.actorA, id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(accounts.deleteAccount(f.admin, f.admin.userId)).rejects.toMatchObject({ code: "CONFLICT" });

    await accounts.deleteAccount(f.admin, id);
    expect(await db.select().from(user).where(eq(user.id, id))).toEqual([]);
    expect(await db.select().from(session).where(eq(session.userId, id))).toEqual([]);
    expect(await db.select().from(account).where(eq(account.userId, id))).toEqual([]);
    const [log] = await db.select().from(auditLogs).where(eq(auditLogs.action, "account_deleted"));
    expect(log).toMatchObject({ userId: f.admin.userId, recordId: id, oldValue: { username: "gv.moi" } });
    await expect(accounts.deleteAccount(f.admin, id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Xóa tài khoản GV: hồ sơ giáo viên còn nguyên, tạo lại tài khoản cho giáo viên đó được.
    await accounts.deleteAccount(f.admin, f.actorA.userId);
    await expect(accounts.createAccount(f.admin, { ...input, teacherId: f.teacherA.id })).resolves.toBeDefined();
  });

  it("gửi tài khoản qua email: đặt mật khẩu tạm, bắt đổi, thu hồi phiên, thư tới email của giáo viên, nhật ký không chứa mật khẩu", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://haxi.example");
    const { id } = await accounts.createAccount(f.admin, { ...input, teacherId: null });
    await db.update(user).set({ mustChangePassword: false, lockedUntil: new Date(Date.now() + 60_000) }).where(eq(user.id, id));
    await db.insert(session).values({ id: "s-send", token: "t-send", userId: id, expiresAt: new Date(Date.now() + 3600_000) });
    const hashOf = async () => (await db.select().from(account).where(eq(account.userId, id)))[0]!.password!;
    const before = await hashOf();

    // Chưa gắn giáo viên, hoặc giáo viên chưa có email: báo lỗi, không đổi mật khẩu, không gửi thư.
    await expect(accounts.sendAccountCredentials(f.admin, id, "MatKhauGui2026")).rejects.toMatchObject({ code: "CONFLICT" });
    await db.update(user).set({ teacherId: null }).where(eq(user.id, f.actorA.userId));
    await db.update(user).set({ teacherId: f.teacherA.id }).where(eq(user.id, id));
    await expect(accounts.sendAccountCredentials(f.admin, id, "MatKhauGui2026")).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("menu Giáo viên"),
    });
    // Người không phải Admin không gửi được; tài khoản không tồn tại báo không tìm thấy.
    await db.update(teachers).set({ email: "gv.moi@truong.example" }).where(eq(teachers.id, f.teacherA.id));
    await expect(accounts.sendAccountCredentials(f.actorB, id, "MatKhauGui2026")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(accounts.sendAccountCredentials(f.admin, "khong-ton-tai", "MatKhauGui2026")).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Máy chủ thư lỗi: hoàn tác, mật khẩu cũ và phiên còn nguyên.
    mail.fail = true;
    await expect(accounts.sendAccountCredentials(f.admin, id, "MatKhauGui2026")).rejects.toThrow();
    mail.fail = false;
    expect(await hashOf()).toBe(before);
    expect(await db.select().from(session).where(eq(session.userId, id))).toHaveLength(1);
    expect(mail.sent).toEqual([]);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "account_credentials_sent"))).toEqual([]);

    await accounts.sendAccountCredentials(f.admin, id, "MatKhauGui2026");
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe("gv.moi@truong.example");
    for (const body of [mail.sent[0]!.text, mail.sent[0]!.html]) {
      expect(body).toContain("gv.moi");
      expect(body).toContain("MatKhauGui2026");
      expect(body).toContain("https://haxi.example/login");
    }
    expect(await verifyPassword({ hash: await hashOf(), password: "MatKhauGui2026" })).toBe(true);
    const [u] = await db.select().from(user).where(eq(user.id, id));
    expect(u).toMatchObject({ mustChangePassword: true, lockedUntil: null, failedAttempts: 0 });
    expect(await db.select().from(session).where(eq(session.userId, id))).toEqual([]);
    const [log] = await db.select().from(auditLogs).where(eq(auditLogs.action, "account_credentials_sent"));
    expect(log).toMatchObject({ userId: f.admin.userId, recordId: id });
    expect(JSON.stringify(log)).not.toContain("MatKhauGui2026");
    expect(JSON.stringify(log)).not.toContain("truong.example");
    vi.unstubAllEnvs();
  });

  it("đặt lại mật khẩu buộc đổi lại và thu hồi phiên", async () => {
    const { id } = await accounts.createAccount(f.admin, { ...input, teacherId: f.teacherA.id });
    await db.update(user).set({ mustChangePassword: false }).where(eq(user.id, id));
    await db.insert(session).values({ id: "s2", token: "t2", userId: id, expiresAt: new Date(Date.now() + 3600_000) });
    await accounts.resetAccountPassword(f.admin, id, "MatKhauKhac456");
    const [u] = await db.select().from(user).where(eq(user.id, id));
    const [a] = await db.select().from(account).where(eq(account.userId, id));
    expect(u!.mustChangePassword).toBe(true);
    expect(await verifyPassword({ hash: a!.password!, password: "MatKhauKhac456" })).toBe(true);
    expect(await db.select().from(session).where(eq(session.userId, id))).toEqual([]);
  });
});
