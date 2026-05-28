import { Telegraf } from "telegraf";
import type { Context } from "telegraf";
import { loadConfig, isAllowedTelegramUser } from "./config.js";
import { runPlannerExecutor } from "./agentRunner.js";
import { appendChatTurn, getChatContext } from "./chatMemory.js";
import { isDirectEmailCheck, listRecentEmails, requestedEmailCount } from "./directGmail.js";
import { rememberNotificationChatId, startEmailMonitor } from "./emailMonitor.js";
import { runMemoryUpdatePipeline } from "./memoryUpdate.js";
import { downloadTelegramImage, imageCaption } from "./telegramMedia.js";
import { transcribeTelegramVoice } from "./voice.js";
import { chunkPlainTextForTelegram, modelOutputToTelegramHtml } from "./telegramFormat.js";

/** Leave headroom: HTML tags expand vs plain `**` / `` ` ``. */
const TELEGRAM_CHUNK = 3500;

async function main(): Promise<void> {
  const config = loadConfig({ requireBotToken: true });
  const bot = new Telegraf(config.botToken!);

  bot.start((ctx) => {
    if (!isAllowedTelegramUser(config, ctx.from?.id)) return ctx.reply("Not allowed.");
    if (ctx.chat?.id !== undefined) void rememberNotificationChatId(config, ctx.chat.id);
    return ctx.reply(
      "Manager4Yehor online. I can use gmail-local (Gmail/Calendar) and telegramMainFi MCP tools through a local Cursor SDK agent. Use /remember to save a fact to memory.md.",
    );
  });

  bot.on("text", async (ctx) => {
    const userId = ctx.from?.id;
    if (!isAllowedTelegramUser(config, userId)) {
      await ctx.reply("Not allowed.");
      return;
    }

    const text = ctx.message.text.trim();
    if (!text) return;

    if (/^\/remember(\s|$)/i.test(text)) {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) {
        await ctx.reply("No chat id found.");
        return;
      }
      const rest = text.replace(/^\/remember(@[A-Za-z0-9_]+)?/i, "").trim();
      if (!rest) {
        await ctx.reply("Usage: /remember <fact or preference to store>");
        return;
      }
      appendChatTurn(chatId, "user", `/remember ${rest}`);
      await rememberNotificationChatId(config, chatId);
      await ctx.sendChatAction("typing");
      const status = await ctx.reply("Saving to memory…");
      try {
        await runMemoryUpdatePipeline(config, {
          userText: rest,
          assistantText: "",
          chatContext: getChatContext(chatId),
          rememberOnly: true,
        });
        await ctx.telegram.deleteMessage(chatId, status.message_id).catch(() => undefined);
        await ctx.reply("Memory update finished (check data/memory.md on the host).");
        appendChatTurn(chatId, "assistant", "(memory update run)");
      } catch (error) {
        await ctx.telegram
          .editMessageText(
            chatId,
            status.message_id,
            undefined,
            `Memory error: ${error instanceof Error ? error.message : String(error)}`,
          )
          .catch(() => undefined);
      }
      return;
    }

    await handleUserRequest(ctx, text);
  });

  bot.on("voice", async (ctx) => {
    const userId = ctx.from?.id;
    if (!isAllowedTelegramUser(config, userId)) {
      await ctx.reply("Not allowed.");
      return;
    }

    await ctx.sendChatAction("typing");
    const status = await ctx.reply("Transcribing voice...");
    try {
      const voice = ctx.message.voice;
      const transcription = await transcribeTelegramVoice(ctx, voice.file_id, config);
      await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => undefined);
      await ctx.reply(`Voice heard: ${transcription}`);
      await handleUserRequest(ctx, transcription);
    } catch (error) {
      await ctx.telegram
        .editMessageText(ctx.chat.id, status.message_id, undefined, `Voice error: ${error instanceof Error ? error.message : String(error)}`)
        .catch(() => undefined);
    }
  });

  bot.on("photo", async (ctx) => {
    const userId = ctx.from?.id;
    if (!isAllowedTelegramUser(config, userId)) {
      await ctx.reply("Not allowed.");
      return;
    }

    await ctx.sendChatAction("typing");
    const status = await ctx.reply("Reading image...");
    try {
      const largest = ctx.message.photo.at(-1);
      if (!largest) throw new Error("No photo payload found.");
      const image = await downloadTelegramImage(ctx, largest.file_id, "image/jpeg");
      await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => undefined);
      await handleUserRequest(ctx, imageCaption(ctx.message.caption), [image]);
    } catch (error) {
      await ctx.telegram
        .editMessageText(ctx.chat.id, status.message_id, undefined, `Image error: ${error instanceof Error ? error.message : String(error)}`)
        .catch(() => undefined);
    }
  });

  bot.on("document", async (ctx) => {
    const userId = ctx.from?.id;
    if (!isAllowedTelegramUser(config, userId)) {
      await ctx.reply("Not allowed.");
      return;
    }

    const doc = ctx.message.document;
    if (!doc.mime_type?.startsWith("image/")) {
      await ctx.reply("I can handle image documents, but this file is not an image.");
      return;
    }

    await ctx.sendChatAction("typing");
    const status = await ctx.reply("Reading image...");
    try {
      const image = await downloadTelegramImage(ctx, doc.file_id, doc.mime_type);
      await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id).catch(() => undefined);
      await handleUserRequest(ctx, imageCaption(ctx.message.caption), [image]);
    } catch (error) {
      await ctx.telegram
        .editMessageText(ctx.chat.id, status.message_id, undefined, `Image error: ${error instanceof Error ? error.message : String(error)}`)
        .catch(() => undefined);
    }
  });

  bot.catch((error) => {
    console.error("Telegram bot error:", error);
  });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  const me = await bot.telegram.getMe();
  void bot.launch({ dropPendingUpdates: true });
  startEmailMonitor(bot, config);
  console.log(`Manager4Yehor SDK bot is running as @${me.username}.`);

  async function handleUserRequest(ctx: Context, text: string, images?: Array<{ data: string; mimeType: string }>): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) {
      await ctx.reply("No chat id found.");
      return;
    }

    appendChatTurn(chatId, "user", images?.length ? `${text} [${images.length} image(s) attached]` : text);
    await rememberNotificationChatId(config, chatId);
    await ctx.sendChatAction("typing");
    const status = await ctx.reply("Working...");
    try {
      if (!images?.length && isDirectEmailCheck(text)) {
        const reply = await listRecentEmails(config, requestedEmailCount(text));
        appendChatTurn(chatId, "assistant", reply);
        await ctx.telegram.deleteMessage(chatId, status.message_id).catch(() => undefined);
        await sendLongReply(ctx, reply);
        return;
      }

      const reply = await runPlannerExecutor(config, text, getChatContext(chatId), images);
      appendChatTurn(chatId, "assistant", reply);
      await ctx.telegram.deleteMessage(chatId, status.message_id).catch(() => undefined);
      await sendLongReply(ctx, reply);
      void runMemoryUpdatePipeline(config, {
        userText: text,
        assistantText: reply,
        chatContext: getChatContext(chatId),
        rememberOnly: false,
      }).catch((err) => console.warn("memory_update background:", err));
    } catch (error) {
      await ctx.telegram.deleteMessage(chatId, status.message_id).catch(() => undefined);
      await ctx.reply(`Bot error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function sendLongReply(ctx: Context, text: string): Promise<void> {
  const safeText = text.trim() || "(empty response)";
  const pieces = chunkPlainTextForTelegram(safeText, TELEGRAM_CHUNK);
  for (const piece of pieces) {
    const html = modelOutputToTelegramHtml(piece);
    try {
      await ctx.reply(html, { parse_mode: "HTML" });
    } catch {
      await ctx.reply(piece);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
