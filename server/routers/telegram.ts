import { z } from "zod";
import jwt from "jsonwebtoken";
import { COOKIE_NAME } from "../../shared/const";
import { getSessionCookieOptions } from "../_core/cookies";
import { adminProcedure, protectedProcedure, publicProcedure, router } from "../_core/trpc";
import { ENV } from "../env";
import * as db from "../db";
import { sendTelegramMessage } from "../telegramBot";

const BIND_CODE_TTL_MS = 10 * 60 * 1000;

function randomCode(length = 24) {
  let out = "";
  while (out.length < length) out += crypto.randomUUID().replace(/-/g, "");
  return out.slice(0, length).toUpperCase();
}

function maskToken(token: string) {
  if (!token) return "";
  if (token.length <= 12) return `${token.slice(0, 4)}...`;
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}

async function getTelegramSettings() {
  const settings = await db.getAllSettings();
  const envToken = ENV.telegramBotToken.trim();
  const dbToken = String(settings.telegramBotToken || "").trim();
  const token = envToken || dbToken;
  const enabled = settings.telegramBotEnabled === "true" || (!!envToken && settings.telegramBotEnabled !== "false");
  return {
    enabled,
    configured: !!token,
    botUsername: settings.telegramBotUsername || "",
    polling: ENV.telegramBotPolling,
    tokenSource: envToken ? "env" : dbToken ? "database" : "none",
    tokenMasked: maskToken(token),
  };
}

export const telegramRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const settings = await getTelegramSettings();
    const user = await db.getUserById(ctx.user.id);
    return {
      enabled: settings.enabled,
      configured: settings.configured,
      botUsername: settings.botUsername,
      polling: settings.polling,
      bound: !!user?.telegramId,
      account: user?.telegramId
        ? {
            id: user.telegramId,
            username: user.telegramUsername,
            firstName: user.telegramFirstName,
            lastName: user.telegramLastName,
            linkedAt: user.telegramLinkedAt,
            lastSeenAt: user.telegramLastSeenAt,
          }
        : null,
    };
  }),

  adminStatus: adminProcedure.query(async () => {
    return getTelegramSettings();
  }),

  testSend: adminProcedure.mutation(async ({ ctx }) => {
    const settings = await getTelegramSettings();
    if (!settings.enabled || !settings.configured) {
      throw new Error("Telegram 机器人尚未启用或未配置");
    }
    const user = await db.getUserById(ctx.user.id);
    if (!user?.telegramId) {
      throw new Error("当前管理员尚未绑定 Telegram，无法发送测试消息");
    }
    const displayName = user.name || user.username || `#${user.id}`;
    const botLabel = settings.botUsername ? `@${settings.botUsername}` : "当前机器人";
    await sendTelegramMessage(
      user.telegramId,
      [
        "ForwardX Telegram 测试消息",
        "",
        `接收用户：${displayName}`,
        `机器人：${botLabel}`,
        `时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
      ].join("\n"),
    );
    return { success: true };
  }),

  createBindCode: protectedProcedure.mutation(async ({ ctx }) => {
    const settings = await getTelegramSettings();
    if (!settings.configured || !settings.enabled) {
      throw new Error("管理员尚未启用 Telegram 机器人");
    }
    const code = `TG-${randomCode(12)}`;
    const expiresAt = new Date(Date.now() + BIND_CODE_TTL_MS);
    await db.createTelegramBindCode(ctx.user.id, code, expiresAt);
    return {
      code,
      expiresAt,
      expiresInSeconds: Math.floor(BIND_CODE_TTL_MS / 1000),
      botUsername: settings.botUsername,
      configured: settings.configured,
      enabled: settings.enabled,
    };
  }),

  unbind: protectedProcedure.mutation(async ({ ctx }) => {
    await db.unbindTelegramAccount(ctx.user.id);
    return { success: true };
  }),

  login: publicProcedure
    .input(z.object({ code: z.string().min(8).max(64) }))
    .mutation(async ({ input, ctx }) => {
      const user = await db.consumeTelegramLoginCode(input.code.trim().toUpperCase());
      if (!user) throw new Error("Telegram 登录码无效或已过期");
      const token = jwt.sign({ userId: user.id }, ENV.cookieSecret, { expiresIn: "10d" });
      ctx.res.cookie(COOKIE_NAME, token, getSessionCookieOptions(ctx.req));
      const { password, ...safeUser } = user;
      return safeUser;
    }),
});
