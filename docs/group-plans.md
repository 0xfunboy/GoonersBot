# Group Plans

GoonersBot applies a persistent resource plan to every approved Telegram group. The plan is stored
in MongoDB with its counters, so a restart cannot reset limits and concurrent requests cannot race
past a cap.

## Admin control

Use these commands inside the group:

```text
/profile
/profile free
/profile plus
/profile pro
/groupplan
/groupquota
```

`/profile`, `/groupplan`, and `/groupquota` display the active plan and current day/hour counters. Changing a plan preserves the
current counters and applies the new limits immediately.

## Included resources

- Conversational requests: calendar-day and hourly shared caps.
- LLM tokens: recorded per group/day from completed replies.
- Web search and page scanning: reserved before the provider request.
- News: reserved before feed retrieval.
- Generated images: reserved before generation. Jobs are globally serial across all chats.
- Downloaded media: job count and actual prepared upload bytes.
- Passive group traffic: retained as text-only context, never sent to STT, tools, evaluator/Cortex,
  or an LLM. A command, @mention, or reply to the bot is required to spend inference budget.

## Free execution policy

Free groups are direct-request only. Every LLM step, including internal scene analysis, evaluator/Cortex,
reply generation, translation, image-prompt preparation and manual fact extraction, is forced to
`FREE_LLM_MODEL` (production default: `gemma-4-26b-a4b-it`). Embeddings keep using the independently
configured GemRouter `bge-m3` endpoint when retrieval needs semantic search. Free groups do not invoke the
separate vision model and do not run autonomous posting or background memory mining.

## Anti-flood

Each plan additionally controls a per-user cooldown, a per-chat cooldown, and user/chat bursts per
minute. The admission decision is a compare-and-set update of one Mongo quota document; it covers
the hourly, daily, passive and anti-flood state as one operation.

| Anti-flood        |       Free |      Plus |       Pro |
| ----------------- | ---------: | --------: | --------: |
| Per-user cooldown | 30 seconds | 6 seconds |  1 second |
| Per-chat cooldown | 20 seconds | 3 seconds |  1 second |
| User burst        |   1/minute |  6/minute | 20/minute |
| Chat burst        |   3/minute | 16/minute | 60/minute |

All calendar counters use the `Europe/Rome` timezone. The operator-level
`MAX_REPLIES_PER_CHAT_PER_HOUR` value remains an emergency ceiling, while the plan determines the
effective group limit.
