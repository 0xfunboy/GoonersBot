# Realistic Attack Plan

Branch: `realistic`

Goal: turn GoonersBot from a mostly roast-driven group character into a more realistic friend in the
chat: sharp, vulgar and NSFW-capable when the room asks for it, but mainly useful, context-aware,
fact-aware and socially calibrated. The bot must keep every aggressive and adult capability it has
today; the change is about timing, judgment and signal-to-noise.

## Current Shape

The current Telegram flow is already a good base:

1. `src/telegram/handlers/message.ts` gates permissions, terms, approvals, tracking, autoengage,
   usage and NSFW model routing.
2. `src/services/reply.ts` runs the brain pipeline: media transcription/vision, scene analysis,
   memory retrieval, grounding, knowledge recall, heat, style, plan, generation, ranking,
   repetition guard, optional image output.
3. `src/brain/sceneAnalyzer.ts` extracts the chat scene.
4. `src/brain/replyPlanner.ts` decides the reply intent.
5. `src/prompts/generator.ts` builds the persona prompt.
6. `src/brain/responseRanker.ts` picks the best candidate.
7. `src/search/groundingService.ts`, `src/news/newsService.ts`, `src/knowledge/*` and
   `src/memory/*` are the existing provider/RAG building blocks.

The important problem is not missing tools. The problem is orchestration: the bot has tools, memory,
heat and style, but no explicit turn-level judgment that asks: "what would a real friend add here?"

## Current Behavioral Problem

Today the strongest behavioral forces are:

- reply intent: often `roast_user`, `chaos_reply` or direct answer;
- style: aggression, vulgarity, absurdity and degen variants;
- heat: raises hostility toward a user;
- memory: can create callbacks on known personal/group lore;
- ranker: penalizes assistant tone and repetition, and weakly rewards factual answers.

That means the bot can choose a reply because it is punchy, not because it contributes. In group
terms: it sometimes confuses "being the funny asshole" with "being the brother who calls bullshit
and makes the room smarter".

## Target Model

Add a turn-level `RealisticOrchestrator` with three steps:

1. Evaluator: decide whether an action is useful, which kind, and how strong the intervention should
   be.
2. Providers: collect the data needed for that decision: group RAG, current-world RAG, web/search,
   news, media, other model calls if configured.
3. Action: merge the data into one reply plan and one prompt block, then generate the final answer
   in the existing persona.

This should run during normal conversation, not only commands. The user should not need to say
`/search` or `/news`; the bot should infer it when the conversation contains uncertainty, claims,
recent events, prices, releases, scores, public facts, technical claims or "this sounds wrong".

## Layer 1: Group RAG

Purpose: understand the people and the social context without becoming a stale insult machine.

Build on current `memory_items` and `MemoryRetriever`, but separate retrieval intent:

- `personal_lore`: facts about the current speaker or mentioned users.
- `group_lore`: recurring jokes, group history, projects, preferences, rivalries.
- `social_calibration`: recent bot feedback, repeated tics, heat, whether the bot has been too much.

Changes:

- Extend `ReplyPlan` with `socialRole`: `friend`, `truth_checker`, `banter`, `lorekeeper`,
  `quiet_listener`, `technical_peer`.
- Extend memory retrieval input with the evaluator action, so lore is used only when it supports the
  turn.
- Add a "do not weaponize stale lore" rule: if the turn is factual, technical or serious, personal
  lore is flavor only, never the payload.
- Add debug fields so `/brain` can show why a memory was used.

## Layer 2: Current-World RAG

Purpose: give the bot the lived context of the current internet/news cycle without making it a news
bot.

Build on:

- `GroundingService` for on-demand web and image grounding.
- `NewsService` for fresh RSS-driven items.
- `KnowledgeRetriever` for stable curated culture/tech/anime/dev knowledge.

Changes:

- Replace simple regex-only grounding with evaluator-driven grounding.
- Keep regex triggers as cheap fast-paths, but let the evaluator request web/news when the message
  has a checkable factual claim.
- Add a `ClaimCheckProvider` path:
  - extract concrete claims from current message and recent thread;
  - decide whether they are stable, current, subjective or unverifiable;
  - search only when the claim is checkable and freshness matters.
- Add `NewsContextProvider`:
  - when recent chat topic overlaps with ranked news topics, provide 1-3 fresh items;
  - use as background, not as an autopost unless autopost is active.

## Evaluator

Create `src/brain/turnEvaluator.ts`.

Input:

- scene analysis;
- current message and recent chat;
- addressed/passive state;
- mode and NSFW state;
- recent bot replies/feedback;
- available tool capabilities;
- lightweight facts from group/current-world RAG.

Output:

```ts
interface TurnEvaluation {
  shouldAct: boolean;
  action:
    | 'answer'
    | 'challenge_claim'
    | 'ground_search'
    | 'bring_news_context'
    | 'summarize_thread'
    | 'use_group_lore'
    | 'banter_only'
    | 'stay_quiet';
  providerRequests: Array<'group_rag' | 'knowledge_rag' | 'web_search' | 'news' | 'image_lookup'>;
  valueTarget: 'truth' | 'context' | 'joke' | 'support' | 'technical_help' | 'social_glue';
  roastBudget: 'none' | 'light' | 'medium' | 'heavy';
  confidence: number;
  reason: string;
}
```

Rules:

- If the user says something objectively wrong and it is checkable, answer with the correction first.
- If the message is pure banter, roast can be the payload.
- If the message is a real question, useful answer first, insult second.
- If the bot is unsure, it should be blunt about uncertainty instead of hallucinating.
- If it has nothing useful or funny to add, it should stay quiet.
- Recent criticism of the bot should lower roast budget and increase self-awareness.

## Providers

Create `src/brain/providers/*` or keep this under `src/services/reply.ts` initially if we want a
smaller diff.

Suggested provider result:

```ts
interface ProviderBundle {
  groupContext?: string;
  knowledgeContext?: string;
  webContext?: string;
  newsContext?: string;
  claimCheck?: string;
  sources?: string[];
}
```

Implementation order:

1. Wrap existing memory and knowledge retrieval into named provider blocks.
2. Wrap existing `ground()` into a provider that can be requested by evaluator.
3. Add a news provider using `NewsService.ranked()` with dynamic terms from current topic, recent
   chat and retrieved lore.
4. Add source tracking to brain debug.

## Action And Prompting

Update `ReplyPlanner` and `buildGeneratorUserPrompt`:

- Add the evaluator result to `ReplyPlan`.
- Add "value target" to the prompt.
- Add "roast budget" to the prompt.
- Add a hard rule: never let the insult replace the answer when the action is `answer`,
  `challenge_claim`, `ground_search` or `bring_news_context`.
- Add a hard rule: when challenging a claim, be concrete: say what is wrong, what is known, and what
  uncertainty remains.
- Keep NSFW and aggression enabled, but bind them to the action. The bot can be filthy in banter;
  it should not turn every factual correction into a recycled personal insult.

## Personality Direction

Replace the current center of gravity:

- From: "toxic but socially-aware gremlin".
- To: "a sharp, loyal, foul-mouthed group friend who cares about truth, timing and the room".

Keep:

- vulgarity;
- NSFW mode;
- roasts;
- group lore;
- anime/degen tastes;
- refusal fallback;
- image/media/music/link features.

Reduce:

- automatic personal callbacks;
- roast-only answers to factual questions;
- assistant filler;
- repeated catchphrases;
- "I am useful" meta-talk.

## Phased Implementation

### Phase 1: Observability And Types

- Add `TurnEvaluation` types.
- Add `evaluation` and `providerSources` to `BrainDebugTurn`.
- Extend `/brain` and `/debuglast` to show evaluator action, provider requests, roast budget and
  reason.
- Tests: evaluator type defaults, debug serialization.

### Phase 2: Deterministic Evaluator

- Implement a deterministic evaluator first, no extra LLM call.
- Use scene, regexes, message shape, grounding triggers and bot feedback.
- Route:
  - direct factual/current question -> `ground_search`;
  - checkable false-looking claim -> `challenge_claim`;
  - normal direct question -> `answer`;
  - pure banter -> `banter_only`;
  - low-value passive chatter -> `stay_quiet`.
- Tests: question, wrong claim, pure banter, bot criticism, passive chatter.

### Phase 3: Provider Orchestration

- Move current `ground()` into provider orchestration.
- Add news context provider.
- Make provider calls parallel after evaluation.
- Add timeouts/fallbacks so a dead provider never kills the reply.
- Tests: requested provider is called, unrequested provider is not, fallback leaves reply alive.

### Phase 4: Planner And Prompt Integration

- Extend `ReplyPlan` with `action`, `valueTarget`, `roastBudget`, `mustBringValue`.
- Teach planner that `challenge_claim` and `ground_search` are answer-first.
- Update generator prompt to include provider bundle and behavioral contract.
- Tests: factual plans must answer; banter plans may roast; bot criticism avoids stale lore.

### Phase 5: Ranker Upgrade

- Add value scoring:
  - factual answer must mention the core terms from question/provider context;
  - challenge must include correction language;
  - banter can win on punch if no factual action is required.
- Penalize roast-only candidates when `mustBringValue=true`.
- Tests: useful answer beats roast-only; correction beats vague dunk.

### Phase 6: LLM Evaluator Optional

- Add env flags:
  - `REALISTIC_EVALUATOR_ENABLED=true`
  - `REALISTIC_EVALUATOR_MODEL`
  - `REALISTIC_EVALUATOR_TEMPERATURE=0.1`
- Keep deterministic evaluator as fallback.
- Only use model evaluator for ambiguous turns; cheap deterministic rules handle obvious cases.

### Phase 7: Rollout Tuning

- Start with conservative passive engagement.
- Enable evaluator debug in the live group.
- Review `/debuglast` after bad replies and tune:
  - roast budget;
  - grounding triggers;
  - memory usage;
  - news sensitivity.
- Do not remove existing aggressive/NSFW features; tune when they fire.

## Acceptance Criteria

- A direct factual question gets a direct answer before any insult.
- A wrong factual claim gets corrected with sources/context when available.
- A normal roast exchange can still be nasty, funny and NSFW.
- The bot does not reuse personal lore as the default punchline.
- The bot can invoke search/news/knowledge during normal conversation without a command.
- Provider failure degrades to "I do not know" or a normal reply, not a crash.
- `/brain` explains the evaluator action and provider path.
- Existing tests keep passing; new evaluator/provider/ranker tests cover the new contract.

## First Concrete Code Slice

The safest first PR on this branch should be:

1. Add `TurnEvaluation` types and a deterministic evaluator.
2. Add evaluator result to `ReplyOutcome` and brain debug.
3. Feed evaluator into `ReplyPlanner`.
4. Add prompt lines for `valueTarget` and `roastBudget`.
5. Add tests proving roast-only loses when the turn needs truth or a real answer.

This gives the bot a spine before adding more providers. Once the spine works, web/news/current-world
RAG can become stronger without turning every reply into an infodump.
