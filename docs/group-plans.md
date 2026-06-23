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
```

`/profile` displays the active plan and current day/hour counters. Changing a plan preserves the
current counters and applies the new limits immediately.

## Included resources

- Conversational requests: calendar-day and hourly shared caps.
- LLM tokens: recorded per group/day from completed replies.
- Web search and page scanning: reserved before the provider request.
- News: reserved before feed retrieval.
- Generated images: reserved before generation. Jobs are globally serial across all chats.
- Downloaded media: job count and actual prepared upload bytes.
- Passive replies: an independent hourly allowance, so auto-engage cannot consume direct-request
  capacity unchecked.

## Anti-flood

Each plan additionally controls a per-user cooldown, a per-chat cooldown, and user/chat bursts per
minute. The admission decision is a compare-and-set update of one Mongo quota document; it covers
the hourly, daily, passive and anti-flood state as one operation.

| Anti-flood        |       Free |      Plus |       Pro |
| ----------------- | ---------: | --------: | --------: |
| Per-user cooldown | 12 seconds | 6 seconds |  1 second |
| Per-chat cooldown |  8 seconds | 3 seconds |  1 second |
| User burst        |   3/minute |  6/minute | 20/minute |
| Chat burst        |   8/minute | 16/minute | 60/minute |

All calendar counters use the `Europe/Rome` timezone. The operator-level
`MAX_REPLIES_PER_CHAT_PER_HOUR` value remains an emergency ceiling, while the plan determines the
effective group limit.
