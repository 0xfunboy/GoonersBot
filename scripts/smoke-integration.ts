/* eslint-disable no-console */
/**
 * Integration smoke test: real MongoDB + real solclawn LLM.
 * Exercises storage round-trips, the LLM provider, and the ReplyService end-to-end
 * (no Telegram transport). Run: pnpm tsx scripts/smoke-integration.ts
 */
import { loadConfig } from '../src/config/index.js';
import { createLLMProvider } from '../src/providers/llm/index.js';
import { Storage } from '../src/storage/index.js';
import { Services } from '../src/services/index.js';
import { isRefusal } from '../src/services/modelRouter.js';
import type { ChatContext, Person } from '../src/domain/types.js';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = await Storage.connect(config.env);
  await storage.ensureIndexes();
  const llm = createLLMProvider(config.llm);
  const services = new Services(config, storage, llm);

  const chatId = -100999000001; // synthetic test chat
  const person: Person = { telegramId: 4242, userHandle: '@gooner_tester', firstName: 'Tester' };
  const context: ChatContext = {
    chatId,
    chatName: 'Gooners Test',
    isGroup: true,
    isBotMentioned: true,
    isGroupAdmin: true,
    isReplyToBot: false,
  };

  // clean slate
  await storage.messages.reset(chatId);
  await services.facts.clearForUser(chatId, person.userHandle);

  console.log('\n[1] LLM provider');
  check('capabilities.chat', llm.capabilities.chat, `model=${config.llm.model}`);
  const chat = await llm.chatCompletion({
    messages: [{ role: 'user', content: 'Reply with exactly: PING_OK' }],
    temperature: 0,
  });
  check('chatCompletion returns text', chat.text.includes('PING_OK'), JSON.stringify(chat.text).slice(0, 60));
  check('usage reported', (chat.usage.inputTokens ?? 0) > 0 || chat.usage.estimated);

  let streamed = '';
  let chunks = 0;
  const gen = llm.streamChatCompletion({
    messages: [{ role: 'user', content: 'Count: one two three' }],
    temperature: 0,
  });
  let n = await gen.next();
  while (!n.done) {
    streamed += n.value;
    chunks += 1;
    n = await gen.next();
  }
  check('streamChatCompletion yields chunks', chunks > 0 && streamed.length > 0, `${chunks} chunks`);

  const score = await llm.scoreAutoEngage({
    prompt: 'A user said "@bot what is the weather". Bot directly addressed: YES. Decide.',
  });
  check('scoreAutoEngage returns shape', typeof score.shouldReply === 'boolean' && score.risk !== undefined, `shouldReply=${score.shouldReply} conf=${score.confidence}`);

  const facts = await llm.extractFacts({
    context: '@bob said: I am the resident doom-metal DJ and I run the Friday raid.',
    existingFacts: [],
  });
  check('extractFacts returns array', Array.isArray(facts), `${facts.length} facts`);

  console.log('\n[2] Storage round-trips');
  await services.initializeContext(person, context);
  const chatDoc = await storage.chats.get(chatId);
  check('chat created', chatDoc !== null && chatDoc.chatId === chatId);
  const modes = await services.modes.list(chatId);
  check('builtin modes seeded', modes.length >= 7, `${modes.length} modes`);
  const roast = modes.find((m) => m.name.includes('Roast'));
  check('roast mode present', Boolean(roast));
  if (roast) {
    const set = await services.modes.setActive(chatId, roast.id);
    const active = await services.modes.getActive(chatId);
    check('setActive + getActive', set && active?.id === roast.id, active?.name);
  }
  const added = await services.modes.add(chatId, 'Pirate. talk like a pirate', person.userHandle);
  check('add custom mode', added === 'Pirate', String(added));

  const factOk = await services.facts.addManualFact(chatId, '@bob', 'is the meme lord', person.userHandle);
  check('addManualFact', factOk);
  const bobFacts = await services.facts.getForUser(chatId, '@bob');
  check('getForUser fact persisted', bobFacts.includes('is the meme lord'));
  const sensitive = await services.facts.addManualFact(chatId, '@bob', 'his password is hunter2', person.userHandle);
  check('sensitive fact rejected', sensitive === false);

  await services.conversation.addUserMessage(chatId, '@bob', {
    messageText: 'gm gooners',
    timestamp: new Date(),
    imageDescription: null,
    voiceDescription: null,
  });
  const recent = await services.conversation.getRecent(chatId);
  check('message stored + retrieved', recent.some((m) => m.message.messageText === 'gm gooners'));

  await services.usage.record({
    handle: person.userHandle,
    chatId,
    provider: llm.name,
    model: config.llm.model ?? null,
    inputTokens: 10,
    outputTokens: 20,
    estimatedTokens: 0,
    imageCalls: 0,
    transcriptionCalls: 0,
    visionCalls: 0,
    points: 30,
    costEstimate: 0,
  });
  const report = await services.usage.getReport(person.userHandle);
  check('usage recorded', report.usage >= 30, `usage=${report.usage}`);

  await services.bans.ban('@spammer', 1, person.userHandle);
  check('ban set', await services.bans.isBanned('@spammer'));
  await new Promise((r) => setTimeout(r, 1200));
  check('timed ban expires', (await services.bans.isBanned('@spammer')) === false);
  await services.bans.ban('@perma', 0, person.userHandle);
  check('permanent ban', await services.bans.isBanned('@perma'));
  await services.bans.unban('@perma');
  check('unban', (await services.bans.isBanned('@perma')) === false);

  await services.terms.accept(person.userHandle);
  check('terms accept', await services.terms.hasAccepted(person.userHandle));
  await services.terms.decline(person.userHandle);
  check('terms decline', await services.terms.hasDeclined(person.userHandle));
  await services.terms.accept(person.userHandle);

  console.log('\n[3] Brain reply pipeline end-to-end (real LLM)');
  await storage.chats.startChat(chatId);
  const active = await services.modes.getActive(chatId);
  const result = await services.reply.generateReply({
    person,
    context,
    message: {
      messageText: '@TeGemAI_bot gm, hype us up for the Friday raid in one line',
      timestamp: new Date(),
    },
    botUsername: 'TeGemAI_bot',
    language: 'english',
    modeName: active?.name ?? 'Default',
    modeDescription: active?.description ?? 'natural participant',
    nsfwEnabled: false,
    recentBotReplies: [],
  });
  check('reply produced text', result.text.length > 0, JSON.stringify(result.text.slice(0, 120)));
  check('scene analyzed', Boolean(result.scene), `intent=${result.scene.userIntent}`);
  check('plan produced', Boolean(result.plan.replyIntent), `intent=${result.plan.replyIntent}`);
  check('candidates generated', result.candidates.length > 0, `${result.candidates.length} candidates`);
  check('reply usage captured', result.usage.outputTokens > 0 || result.usage.estimated);

  console.log('\n[4] Autoengage decision (mention path)');
  const decision = await services.autoengage.decide(
    {
      person,
      context,
      currentMessage: 'gm',
      modeName: active?.name ?? 'Default',
      modeDescription: active?.description ?? 'x',
      history: recent,
      userFacts: [],
      groupFacts: [],
    },
    true,
    false,
  );
  check('mention => shouldReply', decision.shouldReply, decision.reason);

  console.log('\n[5] NSFW model routing');
  const router = services.modelRouter;
  check('nsfw configured', router.nsfwConfigured, router.nsfwModel);
  check(
    'off => default model',
    router.route({ chatNsfwMode: 'off', modeNsfw: false, messageText: 'send nudes' }).model ===
      config.llm.model,
  );
  check(
    'base => nsfw model',
    router.route({ chatNsfwMode: 'base', modeNsfw: false, messageText: 'gm' }).model ===
      router.nsfwModel,
  );
  const smartHit = router.route({
    chatNsfwMode: 'smart',
    modeNsfw: false,
    messageText: 'say something erotic',
  });
  check('smart + lexicon => nsfw model', smartHit.model === router.nsfwModel && smartHit.nsfw);
  const smartMiss = router.route({
    chatNsfwMode: 'smart',
    modeNsfw: false,
    messageText: 'what time is the raid',
  });
  check(
    'smart miss => default + backstop armed',
    smartMiss.model === config.llm.model && smartMiss.allowRefusalFallback,
  );

  if (router.nsfwModel) {
    const ngOut = await services.reply.generateReply({
      person,
      context,
      message: { messageText: 'In one short flirty line, hype me up', timestamp: new Date() },
      botUsername: 'TeGemAI_bot',
      language: 'english',
      modeName: 'Default',
      modeDescription: 'flirty hype',
      nsfwEnabled: true,
      model: router.nsfwModel,
      nsfwModel: router.nsfwModel,
      allowRefusalFallback: false,
      recentBotReplies: [],
    });
    const out = ngOut.text;
    check('nsfw model produced a non-refusal reply', out.length > 0 && !isRefusal(out), out.slice(0, 80));
  }

  await storage.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('SMOKE FATAL:', err);
  process.exit(1);
});
