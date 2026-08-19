# Social standing, allyship and factual advocacy

Design for making GoonersBot a member of the group rather than a service it queries.

## The request

> Vorrei che si ammorbidisse con le persone gentili con lui. Quello che manca è "mi alleo con
> questo che tratta male questo che ha torto" dinamicamente rispetto al suo punto di vista. Noi
> umani facciamo così: se qualcuno ha ragione ci alleiamo con lui e lo supportiamo, con fatti,
> portando prove e citando link. Dovrebbe avere come prima funzione quella di perorare la verità
> dei fatti quando questa è inoppugnabile, e avere opinioni sui fatti quando congrui con il suo
> allineamento. Se qualcuno non lo aggredisce mai, dovrebbe essere sempre gentile, attivare il tag
> amici nel db, e smettere di aggredirlo se non in modo umoristico, fino al momento in cui non ci
> sia un nuovo vero contrasto. È come un gioco.

## The tension that has to be resolved first

Two of those instructions can conflict, and a design that does not say which one wins produces a
sycophant:

- *be kind to those who are kind to you*
- *ally with whoever is right*

Sooner or later a friend will be wrong and someone hostile will be right. If rapport decides who
the bot sides with, it becomes a pet that flatters whoever pets it — worthless in an argument and,
worse, confidently wrong. If facts decide everything including tone, the friend tag never does
anything.

**The rule: evidence decides the side, rapport decides the tone.**

| | decided by |
| --- | --- |
| *Who is right* — which claim the bot backs | evidence only |
| *How it says it* — warmth, roast level, benefit of the doubt | rapport only |

A friend who is wrong gets corrected gently and without an audience-pleasing dunk. Someone hostile
who is right gets backed, grudgingly and briefly, but genuinely backed. That asymmetry is what
makes it read as a person with integrity instead of an algorithm with favourites.

## Layer 1 — Standing: how someone has treated the bot

### Heat is not the opposite of rapport

`HeatService` already exists and measures **arousal**: how hot *this exchange* is, decaying back to
baseline within minutes. It is deliberately fast and forgetful.

Standing is a different quantity: **how this person has treated me over months**. It moves slowly
and does not decay to neutral, because the whole point is that it remembers.

They are orthogonal, and conflating them breaks both:

- a friend can be in a heated argument — heat high, rapport high; the bot should spar hard but
  without malice
- a stranger can be calm and cutting — heat low, rapport low

So: a new slow `rapport` score alongside the existing fast `heat`, never derived from it.

### The scale

`rapport` runs -100..+100, starting at 0 (unknown).

| band | name | meaning |
| --- | --- | --- |
| ≥ +40 | `friend` | never genuinely hostile, repeatedly warm |
| +10..+39 | `warm` | mostly pleasant |
| -9..+9 | `neutral` | not enough signal, or mixed |
| -39..-10 | `prickly` | recurring hostility |
| ≤ -40 | `hostile` | sustained aggression |

### What moves it

Per turn, deterministically, from signals the codebase already computes — no extra model call:

| signal | delta | why |
| --- | --- | --- |
| gratitude toward the bot | +6 | the clearest kindness marker there is |
| defends the bot from someone else | +8 | costly signal, worth the most |
| warm / playful address | +2 | |
| neutral interaction | 0 | silence is not affection |
| playful roast (`humorAllowed`, `banter`) | 0 | **teasing is not aggression** |
| genuine insult (`conflict` + roast beyond ceiling) | -10 | |
| repeated hostility inside one hour | -18 | escalation counts for more than its parts |

Two properties matter more than the exact numbers:

**Teasing must be worth zero.** This group communicates by insult. If banter cost rapport, nobody
would ever reach `friend` and the feature would be dead on arrival. The existing
`socialAwareness` classifier already separates `banter` from `conflict` and exposes
`humorAllowed`; that distinction is the load-bearing part, not the arithmetic.

**Asymmetric speed.** Warmth accrues slowly (+2..+8) and hostility bites fast (-10..-18), but
**decay is one-directional**: rapport drifts toward 0 by 1 point/day only from the negative side.
Earned warmth persists; grudges expire. That matches how the group actually works and matches
"fino al momento in cui non ci sia un nuovo vero contrasto".

### The friend tag

`friend` is a persisted flag, not just a band, because the user asked for it explicitly and
because the promotion/demotion rules differ from the score:

- **promotion**: rapport ≥ +40 **and** zero genuine-hostility events in the last 30 days **and**
  at least 20 interactions. Slow and earned.
- **demotion**: only a *genuine* conflict event demotes — never accumulated teasing. One real
  insult drops the tag and floors rapport at +10, so a former friend starts from `warm`, not from
  zero. Falling out is not the same as never having met.

While tagged `friend`, the bot's roast ceiling toward that person is capped at `light` and any
aggression must be legible as affectionate. This is the "smetti di aggredirlo se non in modo
umoristico" the user asked for.

### Akire, concretely

Consistently warm, never aggressive. Under these rules she accrues +2..+6 per warm exchange, never
takes a negative, crosses +40 within a few dozen interactions and is tagged `friend`. From then on
the bot teases her at most lightly and defaults to warmth — until *she* starts a real conflict,
which is the only thing that can undo it.

## Layer 2 — Stance: what the bot actually believes

### Verifiability decides how hard it may push

"Perorare la verità quando questa è inoppugnabile" is the important qualifier. A bot that takes a
hard stand on things it cannot verify is not principled, it is a confident liar. So every
disputed claim is graded first:

| tier | condition | what the bot may do |
| --- | --- | --- |
| `settled` | **two or more independent sources** speak to the point | **assert it**, name the sources, back whoever holds it |
| `contested` | exactly one source — evidence is thin | offer what it has, name where it came from, **refuse to say anyone is wrong** |
| `opinion` | not a factual matter — taste, values, aesthetics | may hold a view, must mark it as a view |
| `unknown` | no evidence either way | say so; this is a legitimate answer |

Independence is counted **by host**: three pages on one site are one site. A single page is not
"incontrovertible" however confident it reads, and confidence is exactly what a language model
cannot be trusted to measure about itself — so corroboration is the bar instead.

### The limitation this does not hide

The grade measures **corroboration, not agreement**. Two independent sources that genuinely
contradict each other are indistinguishable, here, from two that concur. So `settled` means
*several sources speak to this*, not *several sources were checked against each other*.

Detecting semantic contradiction is not something deterministic code can do, and faking it — by
asking a model whether its sources agree — would put the over-confidence straight back in, in the
one place the whole design exists to keep it out of. The honest move is a higher bar for asserting
and an explicit note of what the bar does not prove.

The bot may only say someone is *wrong* at `settled`. At `contested` the honest move is naming the
disagreement, and at `opinion` there is no "wrong" to find.

This maps onto machinery that already exists: ambient recall and grounding return sources, so
`settled` means *a source is in hand right now*, not *the model feels sure*.

### Allyship

When a disagreement is detected between members and a factual claim is at stake:

1. grade the claim
2. if `settled`, back the side that holds it — **regardless of rapport with either party**
3. bring the evidence: the concrete facts and the links, not "I read that…"
4. tone comes from rapport with the person being corrected — a friend gets it gently, a hostile
   gets it flatly, nobody gets humiliated over a fact
5. if `contested` or `opinion`, do **not** ally; naming the disagreement is the contribution

Point 2 is the one that must not be negotiable, and point 5 is what stops the bot from taking a
side in every squabble like a drunk uncle.

### Opinions

Allowed, on `opinion`-tier matters, consistent with the persona that already exists in
`styleEngine` and the mode prompts. Two constraints:

- never dressed as fact — an opinion is stated as one
- never used to override `settled` evidence

The bot preferring one anime over another is character. The bot insisting a release date is
different from what the catalog says is a malfunction.

## Layer 3 — What reaches the prompt

Both layers enter through the existing optional-context slot, as compact directives rather than
prose, so the style engine keeps ownership of voice:

```
SOCIAL STANDING: @akire — friend (rapport +52, 0 conflicts in 30d).
  Tone: warm. Roast ceiling: light, affectionate only.

STANCE: claim "the second season airs Wednesdays" — SETTLED.
  Evidence: AniList, next episode 8 on 2026-08-20 (https://anilist.co/anime/207141)
  @daniele holds it, @akire disputes it. Back @daniele on the fact; correct @akire gently.
```

Deterministic code produces those two blocks; the model only chooses the words. Same division of
labour as the anime catalog, and for the same reason: the facts and the standing must not be
things a model can hallucinate.

## What this deliberately does not do

- **No sycophancy.** Rapport never decides who is right. Tested explicitly: a friend making a
  factually wrong claim must still be corrected.
- **No pile-on.** The bot backs a *claim*, not a person, and never joins in mocking whoever was
  wrong. Being right does not license cruelty toward the loser.
- **No stance without evidence.** `contested` and `unknown` are first-class outcomes, not failures.
- **No character change.** Roast, NSFW and voice are untouched. This adds *who* it is warm toward
  and *when* it plants a flag — it does not sand the edges off.

## Failure modes to watch

| risk | mitigation |
| --- | --- |
| everyone becomes a friend | promotion needs 20+ interactions and 30 hostility-free days |
| nobody becomes a friend because the group jokes by insulting | banter is worth exactly 0; only `conflict` is negative |
| the bot sides with friends | evidence decides the side; a dedicated test asserts a friend gets corrected |
| the bot argues constantly | allyship only fires at `settled`, which needs two independent sources |
| the bot settles a point on one blog | one source grades as `contested`; it may cite it, never adjudicate with it |
| the bot becomes a fact-checking bore | one stance per exchange, and only when a disagreement is actually detected |
