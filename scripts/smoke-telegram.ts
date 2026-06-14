/* eslint-disable no-console */
/**
 * Telegram-update smoke test: drives synthetic updates through the REAL bot
 * (real dispatch, handlers, services, LLM, MongoDB) with a captured Telegram API
 * (no messages actually leave the machine). Proves command/callback/conversation flows.
 *
 * Run: pnpm tsx scripts/smoke-telegram.ts
 */
import type { Api, RawApi } from 'grammy';
import { loadConfig } from '../src/config/index.js';
import { createLLMProvider } from '../src/providers/llm/index.js';
import { Storage } from '../src/storage/index.js';
import { Services } from '../src/services/index.js';
import { createBot } from '../src/telegram/bot.js';

const CHAT_ID = -100999000777;
const USER = { id: 7777, is_bot: false, first_name: 'Gooner', username: 'gooner_tester' };
const BOT_USERNAME = 'TeGemAI_bot';

const sent: Array<{ method: string; text?: string }> = [];

function makeMessageUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: 'supergroup', title: 'Gooners Test' },
      from: USER,
      text,
      entities: text.startsWith('/')
        ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }]
        : undefined,
    },
  };
}

function makeCallbackUpdate(updateId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: USER,
      chat_instance: 'ci',
      data,
      message: {
        message_id: updateId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CHAT_ID, type: 'supergroup', title: 'Gooners Test' },
        from: { id: 1, is_bot: true, first_name: 'Bot', username: BOT_USERNAME },
        text: 'pick',
      },
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = await Storage.connect(config.env);
  await storage.ensureIndexes();
  // fresh chat
  await storage.messages.reset(CHAT_ID);
  const llm = createLLMProvider(config.llm);
  const services = new Services(config, storage, llm);

  const { bot } = await createBot(config, services);
  await bot.init();

  // Capture transformer: short-circuit outgoing calls, record sends. Treat the user as admin.
  (bot.api as Api<RawApi>).config.use((async (prev, method, payload: Record<string, unknown>, signal) => {
    if (method === 'getChatMember') {
      return {
        ok: true,
        result: { status: 'administrator', user: { ...USER } },
      } as never;
    }
    if (method === 'sendMessage' || method === 'editMessageText') {
      sent.push({ method, text: String(payload['text'] ?? '') });
      return {
        ok: true,
        result: {
          message_id: Math.floor(Math.random() * 1e6),
          date: Math.floor(Date.now() / 1000),
          chat: { id: CHAT_ID, type: 'supergroup' },
          text: payload['text'],
        },
      } as never;
    }
    if (method === 'sendChatAction' || method === 'answerCallbackQuery') {
      return { ok: true, result: true } as never;
    }
    if (method === 'sendPhoto' || method === 'sendVoice') {
      sent.push({ method });
      return {
        ok: true,
        result: { message_id: 1, date: 0, chat: { id: CHAT_ID, type: 'supergroup' } },
      } as never;
    }
    return prev(method, payload, signal);
  }) as Parameters<Api<RawApi>['config']['use']>[0]);

  const lastTextSince = (n: number): string => {
    const slice = sent.slice(n);
    const texts = slice.filter((s) => s.text).map((s) => s.text!);
    return texts[texts.length - 1] ?? '(no text sent)';
  };

  let uid = 1000;
  const step = async (label: string, update: unknown): Promise<void> => {
    const before = sent.length;
    await bot.handleUpdate(update as never);
    const out = lastTextSince(before);
    console.log(`\n▶ ${label}`);
    console.log(`  ⟵ ${out.replace(/\n/g, ' ⏎ ').slice(0, 240)}`);
  };

  console.log('=== Driving a Gooners conversation through the real bot ===');

  await step('/start (admin)', makeMessageUpdate(uid++, '/start'));
  await step('/help', makeMessageUpdate(uid++, '/help'));
  await step('/terms', makeMessageUpdate(uid++, '/terms'));

  // accept terms via callback
  await step('callback terms_response|accept', makeCallbackUpdate(uid++, 'terms_response|accept'));

  await step('/mode (shows keyboard)', makeMessageUpdate(uid++, '/mode'));

  // pick the Roast mode by id
  const modes = await services.modes.list(CHAT_ID);
  const roast = modes.find((m) => m.name.includes('Roast'))!;
  await step(`callback set_chat_mode|${roast.id}`, makeCallbackUpdate(uid++, `set_chat_mode|${roast.id}`));

  await step('/addmode Pirate', makeMessageUpdate(uid++, '/addmode Pirate. talk like a salty pirate'));
  await step('/introduce', makeMessageUpdate(uid++, '/introduce I am the resident doom-metal DJ'));
  await step('/fact @bob', makeMessageUpdate(uid++, '/fact @bob runs the Friday raid'));
  await step('/facts @bob', makeMessageUpdate(uid++, '/facts @bob'));
  await step('/usage', makeMessageUpdate(uid++, '/usage'));
  await step('/conversationtracker (admin)', makeMessageUpdate(uid++, '/conversationtracker'));
  await step('/autoengage (admin)', makeMessageUpdate(uid++, '/autoengage'));

  // A real conversation: mention the bot -> triggers an LLM reply
  await step(
    'mention the bot (LLM reply)',
    makeMessageUpdate(uid++, `@${BOT_USERNAME} gm gooners, roast me in one line`),
  );

  // A passive (non-mention) message while tracking + autoengage are ON
  await step('passive chatter (autoengage decides)', makeMessageUpdate(uid++, 'anyone up for a raid tonight?'));

  console.log(`\n=== Done. ${sent.length} outbound Telegram calls captured. ===`);
  await storage.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('TG SMOKE FATAL:', err);
  process.exit(1);
});
