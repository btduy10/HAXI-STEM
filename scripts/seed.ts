import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

// Khởi tạo CSDL trống. Chạy: npm run db:seed
// Mặc định chỉ tạo tài khoản admin và cấu hình nền (tiêu chí sao, cấu hình) để Admin nhập dữ liệu thật.
// SEED_DEMO_DATA=true (máy phát triển, kiểm thử tự động) tạo thêm dữ liệu mẫu: giáo viên, lớp, học viên, buổi học, sao, quà
// và hai tài khoản gv.lan, gv.minh.
// Từ chối chạy nếu CSDL đã có tài khoản để không ghi đè dữ liệu thật.

const today = new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

async function main() {
  const { db, closeDb } = await import("../src/db");
  const s = await import("../src/db/schema");
  const { hashPassword } = await import("../src/server/password");

  const [{ n }] = (await db.execute(sql`select count(*)::int as n from "user"`)) as unknown as [{ n: number }];
  if (n > 0) {
    console.log("CSDL đã có tài khoản — bỏ qua seed.");
    await closeDb();
    return;
  }

  const demo = process.env.SEED_DEMO_DATA === "true";
  const password = process.env.SEED_DEFAULT_PASSWORD ?? "Haxi@2026";
  const passwordHash = await hashPassword(password);

  const classIds: string[] = [];
  await db.transaction(async (tx) => {
    const demoTeachers = demo
      ? await tx
          .insert(s.teachers)
          .values([
            { code: "GV01", fullName: "Nguyễn Thị Lan", phone: "0901000001", email: "lan@haxi.example" },
            { code: "GV02", fullName: "Trần Văn Minh", phone: "0901000002", email: "minh@haxi.example" },
          ])
          .returning()
      : null;

    // Tài khoản giáo viên do Admin tạo và chỉnh trên giao diện (trang Tài khoản); gv.lan, gv.minh chỉ có ở dữ liệu mẫu.
    const accounts = [
      { username: "admin", name: "Quản trị viên", role: "admin" as const, teacherId: null as string | null },
      ...(demoTeachers
        ? [
            { username: "gv.lan", name: "Nguyễn Thị Lan", role: "teacher" as const, teacherId: demoTeachers[0]!.id },
            { username: "gv.minh", name: "Trần Văn Minh", role: "teacher" as const, teacherId: demoTeachers[1]!.id },
          ]
        : []),
    ];
    for (const a of accounts) {
      const id = randomUUID();
      await tx.insert(s.user).values({
        id,
        name: a.name,
        username: a.username,
        displayUsername: a.username,
        email: `${a.username}@haxi.local`,
        role: a.role,
        teacherId: a.teacherId,
        mustChangePassword: true,
      });
      await tx.insert(s.account).values({ id: randomUUID(), accountId: id, providerId: "credential", userId: id, password: passwordHash });
    }

    await tx.insert(s.starCriteria).values([
      { name: "Hoàn thành nhiệm vụ", stars: 3, type: "reward" },
      { name: "Phát biểu xây dựng bài", stars: 1, type: "reward" },
      { name: "Giúp đỡ bạn", stars: 2, type: "reward" },
      { name: "Sáng tạo vượt yêu cầu", stars: 5, type: "reward" },
      { name: "Mất trật tự", stars: -1, type: "penalty" },
      { name: "Không giữ gìn thiết bị", stars: -2, type: "penalty" },
    ]);

    await tx.insert(s.appSettings).values([
      { key: "attendance_lock_days", value: 7 },
      { key: "max_deduction_per_session", value: 3 },
    ]);

    if (demoTeachers) {
      const [t1, t2] = demoTeachers;
      const [c1, c2] = await tx
        .insert(s.courses)
        .values([
          { name: "Robotics Cơ bản", description: "Lắp ráp và lập trình robot kéo-thả cho học sinh tiểu học.", totalSessions: 24 },
          { name: "Robotics Nâng cao", description: "Cảm biến, thuật toán dò đường và thi đấu.", totalSessions: 32 },
        ])
        .returning();

      const [r1, r2] = await tx
        .insert(s.rooms)
        .values([
          { name: "Phòng Lab 1", capacity: 12 },
          { name: "Phòng Lab 2", capacity: 8 },
        ])
        .returning();

      const [morning, , evening] = await tx
        .insert(s.timeSlots)
        .values([
          { name: "Ca sáng", frame: 1, defaultStart: "08:00", defaultEnd: "09:30" },
          { name: "Ca chiều", frame: 1, defaultStart: "14:00", defaultEnd: "15:30" },
          { name: "Ca tối", frame: 1, defaultStart: "18:00", defaultEnd: "19:30" },
        ])
        .returning();

      const start = iso(addDays(today, -28));
      const end = iso(addDays(today, 90));
      const [k1, k2] = await tx
        .insert(s.classes)
        .values([
          { code: "RB-CB01", name: "Robotics Cơ bản 01", courseId: c1!.id, defaultRoomId: r1!.id, startDate: start, endDate: end, maxSize: 10 },
          { code: "RB-NC01", name: "Robotics Nâng cao 01", courseId: c2!.id, defaultRoomId: r2!.id, startDate: start, endDate: end, maxSize: 8 },
        ])
        .returning();

      await tx.insert(s.classTeachers).values([
        { classId: k1!.id, teacherId: t1!.id, role: "main" },
        { classId: k2!.id, teacherId: t2!.id, role: "main" },
      ]);

      // Lịch mẫu: lớp cơ bản học tối Thứ Ba + Thứ Năm; lớp nâng cao học sáng Thứ Bảy + Chủ nhật.
      await tx.insert(s.scheduleTemplates).values([
        { classId: k1!.id, weekday: 2, timeSlotId: evening!.id },
        { classId: k1!.id, weekday: 4, timeSlotId: evening!.id },
        { classId: k2!.id, weekday: 6, timeSlotId: morning!.id },
        { classId: k2!.id, weekday: 7, timeSlotId: morning!.id },
      ]);
      classIds.push(k1!.id, k2!.id);

      const names = [
        "Lê Gia Bảo", "Phạm Minh Anh", "Hoàng Đức Huy", "Vũ Ngọc Hân", "Đặng Quốc Khánh",
        "Bùi Thảo Vy", "Đỗ Nhật Nam", "Ngô Khánh Linh", "Dương Tuấn Kiệt", "Lý Bảo Ngọc",
        "Trịnh Hải Đăng", "Mai Phương Thảo", "Phan Anh Khoa", "Tạ Minh Châu", "Hồ Gia Huy",
      ];
      const students = await tx
        .insert(s.students)
        .values(
          names.map((fullName, i) => ({
            code: `HV${String(i + 1).padStart(3, "0")}`,
            fullName,
            birthDate: `${2014 + (i % 4)}-${String((i % 12) + 1).padStart(2, "0")}-15`,
            gender: (i % 2 === 0 ? "male" : "female") as "male" | "female",
            schoolGrade: 3 + (i % 5),
            guardianName: `Phụ huynh ${fullName.split(" ").slice(-1)[0]}`,
            phone: `09020000${String(i + 1).padStart(2, "0")}`,
          })),
        )
        .returning();

      await tx.insert(s.enrollments).values(
        students.map((st, i) => ({ classId: i < 8 ? k1!.id : k2!.id, studentId: st.id, joinedAt: start })),
      );

      const [sticker, keychain, kit] = await tx
        .insert(s.gifts)
        .values([
          { name: "Sticker robot", description: "Bộ 5 sticker", stock: 30 },
          { name: "Móc khóa robot", description: "Móc khóa in 3D", stock: 10 },
          { name: "Bộ lắp ráp mini", description: "Bộ robot lắp ráp cỡ nhỏ", stock: 3 },
        ])
        .returning();
      await tx.insert(s.rewardTiers).values(
        // Mốc quà đặt theo lớp (lớp không gắn với khóa học).
        [k1!.id, k2!.id].flatMap((classId) => [
          { classId, minStars: 10, giftId: sticker!.id },
          { classId, minStars: 30, giftId: keychain!.id },
          { classId, minStars: 60, giftId: kit!.id },
        ]),
      );
    }
  });

  if (demo) {
    // Sinh buổi học bằng chính service của ứng dụng, rồi điểm danh sẵn các buổi đã quá hạn khóa.
    const { generateSessions } = await import("../src/server/services/sessions");
    const { sessionRoster } = await import("../src/server/services/attendance");
    const [adminUser] = await db.select().from(s.user).where(sql`${s.user.role} = 'admin'`).limit(1);
    const admin = { userId: adminUser!.id, role: "admin" as const, teacherId: null };
    for (const classId of classIds) await generateSessions(admin, classId);
    const oldSessions = await db.select().from(s.sessions).where(sql`${s.sessions.date} < ${iso(addDays(today, -7))}`);
    for (const session of oldSessions) {
      const roster = await sessionRoster(db, session);
      await db.insert(s.attendances).values(
        roster.map((r, i) => ({
          sessionId: session.id,
          studentId: r.studentId,
          // Rải vài lần vắng/đi trễ qua các buổi và học viên khác nhau cho dữ liệu mẫu giống thật.
          status: ((i + Number(session.date.slice(8))) % 9 === 3 ? "absent" : (i + Number(session.date.slice(8))) % 7 === 5 ? "late" : "present") as
            | "absent"
            | "late"
            | "present",
          recordedBy: adminUser!.id,
        })),
      );
      await db.update(s.sessions).set({ status: "done", content: "Bài học theo giáo trình" }).where(sql`${s.sessions.id} = ${session.id}`);
    }

    // Vài lần ghi sao ở các buổi đã dạy để học viên có số sao khác nhau.
    const { awardStars } = await import("../src/server/services/stars");
    const criteria = await db.select().from(s.starCriteria);
    const byName = (name: string) => criteria.find((c) => c.name === name)!.id;
    for (const [index, session] of oldSessions.entries()) {
      const roster = (await sessionRoster(db, session)).map((r) => r.studentId);
      const give = (name: string, studentIds: string[]) =>
        studentIds.length > 0 ? awardStars(admin, { sessionId: session.id, criteriaId: byName(name), studentIds, note: null }) : null;
      await give("Hoàn thành nhiệm vụ", roster);
      await give("Sáng tạo vượt yêu cầu", roster.slice(0, 2));
      await give("Giúp đỡ bạn", roster.slice(2, 4));
      if (index % 2 === 0) await give("Mất trật tự", roster.slice(-1));
    }
  }

  console.log(demo ? "Đã tạo tài khoản admin, cấu hình nền và dữ liệu mẫu." : "Đã tạo tài khoản admin và cấu hình nền (không có dữ liệu mẫu).");
  console.log("Đã tạo tài khoản admin — mật khẩu tạm lấy từ SEED_DEFAULT_PASSWORD. Tài khoản giáo viên: Admin tạo ở trang Tài khoản.");
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
