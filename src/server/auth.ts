import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { twoFactor, username } from "better-auth/plugins";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { audit } from "./audit";
import { previewOrigins, resolveBaseUrl } from "./base-url";
import { hashPassword, verifyPassword } from "./password";

const MAX_FAILED = Number(process.env.LOGIN_MAX_FAILED_ATTEMPTS ?? 5);
const LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES ?? 15);
// Cookie Secure ở production; FORCE_HTTPS=false chỉ để thử bản build qua HTTP trên máy.
const isProd = process.env.NODE_ENV === "production" && process.env.FORCE_HTTPS !== "false";

export const PASSWORD_MIN_LENGTH = 8;

function bodyUsername(body: unknown): string | null {
  const value = (body as { username?: unknown } | undefined)?.username;
  return typeof value === "string" ? value.trim().toLowerCase() : null;
}

async function findLoginUser(name: string | null) {
  if (!name) return null;
  const [row] = await db
    .select({ id: schema.user.id, lockedUntil: schema.user.lockedUntil, failedAttempts: schema.user.failedAttempts })
    .from(schema.user)
    .where(eq(schema.user.username, name))
    .limit(1);
  return row ?? null;
}

export const auth = betterAuth({
  appName: "HAXI STEM",
  baseURL: resolveBaseUrl(),
  // Chỉ có giá trị ở bản preview của Vercel (tên miền của chính bản preview); production không thêm nguồn nào.
  trustedOrigins: previewOrigins(),
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
      twoFactor: schema.twoFactor,
      rateLimit: schema.rateLimit,
    },
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true, // tài khoản chỉ do Admin tạo
    minPasswordLength: PASSWORD_MIN_LENGTH,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
    password: { hash: hashPassword, verify: verifyPassword },
  },
  user: {
    additionalFields: {
      role: { type: "string", required: true, defaultValue: "teacher", input: false },
      teacherId: { type: "string", required: false, input: false },
      mustChangePassword: { type: "boolean", required: true, defaultValue: true, input: false },
      lockedUntil: { type: "date", required: false, input: false, returned: false },
      failedAttempts: { type: "number", required: true, defaultValue: 0, input: false, returned: false },
      lastLoginAt: { type: "date", required: false, input: false },
    },
  },
  session: {
    expiresIn: 60 * 60 * 12,
    updateAge: 60 * 60,
  },
  advanced: {
    useSecureCookies: isProd,
    defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: isProd },
    // Header chứa IP thật của client do hạ tầng đặt (vd. Netlify: x-nf-client-connection-ip). Chỉ đặt khi
    // hạ tầng luôn ghi đè header này; nếu không, client tự gửi được để né giới hạn tốc độ.
    ...(process.env.CLIENT_IP_HEADER ? { ipAddress: { ipAddressHeaders: [process.env.CLIENT_IP_HEADER] } } : {}),
  },
  rateLimit: {
    enabled: process.env.AUTH_RATE_LIMIT !== "off",
    storage: "database",
    window: 60,
    max: 120,
    customRules: {
      "/sign-in/username": { window: 60, max: 10 },
      "/two-factor/verify-totp": { window: 60, max: 10 },
      "/two-factor/verify-backup-code": { window: 60, max: 5 },
      "/change-password": { window: 60, max: 10 },
    },
  },
  // Chỉ dùng đăng nhập bằng tên đăng nhập; tắt các luồng email/tự phục vụ.
  disabledPaths: [
    "/sign-up/email",
    "/sign-in/email",
    "/request-password-reset",
    "/reset-password",
    "/change-email",
    "/update-user",
    "/delete-user",
    "/is-username-available",
    "/two-factor/send-otp",
    "/two-factor/verify-otp",
  ],
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-in/username") {
        const target = await findLoginUser(bodyUsername(ctx.body));
        if (target?.lockedUntil && target.lockedUntil > new Date()) {
          await audit(db, { userId: target.id, action: "login_blocked_locked", tableName: "user", recordId: target.id });
          throw new APIError("FORBIDDEN", {
            code: "ACCOUNT_LOCKED",
            message: "Tài khoản đang tạm khóa do đăng nhập sai nhiều lần. Vui lòng thử lại sau.",
          });
        }
      }
      if (ctx.path === "/change-password") {
        // Chính sách mật khẩu kiểm tra ở máy chủ (độ dài do Better Auth kiểm tra).
        const next = (ctx.body as { newPassword?: unknown } | undefined)?.newPassword;
        if (typeof next !== "string" || !/[A-Za-z]/.test(next) || !/\d/.test(next)) {
          throw new APIError("BAD_REQUEST", { message: "Mật khẩu phải có cả chữ và số." });
        }
      }
      if (ctx.path === "/two-factor/disable") {
        const current = await getSessionFromCtx(ctx);
        if ((current?.user as { role?: string } | undefined)?.role === "admin") {
          throw new APIError("FORBIDDEN", { message: "Quản trị viên bắt buộc dùng xác thực hai lớp." });
        }
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      const failed = ctx.context.returned instanceof APIError;

      if (ctx.path === "/sign-in/username") {
        const target = await findLoginUser(bodyUsername(ctx.body));
        if (!target) return;
        if (failed) {
          const attempts = target.failedAttempts + 1;
          const lock = attempts >= MAX_FAILED;
          await db
            .update(schema.user)
            .set({
              failedAttempts: lock ? 0 : attempts,
              lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : target.lockedUntil,
            })
            .where(eq(schema.user.id, target.id));
          await audit(db, {
            userId: target.id,
            action: lock ? "login_failed_locked" : "login_failed",
            tableName: "user",
            recordId: target.id,
          });
          return;
        }
        await db
          .update(schema.user)
          .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: sql`now()` })
          .where(eq(schema.user.id, target.id));
        await audit(db, { userId: target.id, action: "login_password_ok", tableName: "user", recordId: target.id });
        return;
      }

      if (failed) return;
      const userId = ctx.context.session?.user.id ?? ctx.context.newSession?.user.id ?? null;
      if (!userId) return;

      if (ctx.path === "/change-password") {
        await db.update(schema.user).set({ mustChangePassword: false }).where(eq(schema.user.id, userId));
        await audit(db, { userId, action: "password_changed", tableName: "user", recordId: userId });
      } else if (ctx.path === "/two-factor/verify-totp" || ctx.path === "/two-factor/verify-backup-code") {
        await audit(db, { userId, action: "login_2fa_ok", tableName: "user", recordId: userId });
      } else if (ctx.path === "/two-factor/enable" || ctx.path === "/two-factor/disable") {
        await audit(db, { userId, action: ctx.path.slice(1).replace("/", "_"), tableName: "user", recordId: userId });
      } else if (ctx.path === "/sign-out") {
        await audit(db, { userId, action: "logout", tableName: "user", recordId: userId });
      }
    }),
  },
  plugins: [
    username({ minUsernameLength: 3, maxUsernameLength: 32 }),
    twoFactor({ issuer: "HAXI STEM" }),
    nextCookies(), // phải đứng cuối
  ],
});

export type AuthSession = typeof auth.$Infer.Session;
