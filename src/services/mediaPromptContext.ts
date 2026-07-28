export interface MediaCharacterContinuity {
  /** Stable fictional/community nickname, not an inferred real-world identity. */
  name: string;
  visualDescription: string;
  wardrobe?: string;
}

export interface MediaPromptContext {
  creatorHandle?: string;
  /** What the media should accomplish: meme, explanation, reaction, poster, etc. */
  intent?: string;
  groupAesthetic?: string;
  desiredMood?: string;
  relevantLore?: string[];
  recentMessages?: Array<{ handle: string; text: string }>;
  continuity?: {
    seriesId?: string;
    previousPrompt?: string;
    characters?: MediaCharacterContinuity[];
  };
}

/**
 * Serialize bounded chat context as explicitly untrusted creative reference.
 *
 * The prompt model is told to use only visually relevant facts. This prevents a random chat line
 * from silently replacing the user's media request while still supporting recurring characters,
 * visual callbacks and consistent community aesthetics.
 */
export function mediaContextBlock(context?: MediaPromptContext): string {
  if (!context) return '(none)';
  const recent = (context.recentMessages ?? [])
    .slice(-6)
    .map((message) => `${compact(message.handle, 60)}: ${compact(message.text, 240)}`);
  const characters = (context.continuity?.characters ?? [])
    .slice(0, 8)
    .map(
      (character) =>
        `${compact(character.name, 80)} = ${compact(character.visualDescription, 300)}` +
        (character.wardrobe ? `; wardrobe=${compact(character.wardrobe, 180)}` : ''),
    );
  return [
    context.creatorHandle ? `creator=${compact(context.creatorHandle, 80)}` : '',
    context.intent ? `intent=${compact(context.intent, 300)}` : '',
    context.groupAesthetic ? `group aesthetic=${compact(context.groupAesthetic, 400)}` : '',
    context.desiredMood ? `desired mood=${compact(context.desiredMood, 250)}` : '',
    context.relevantLore?.length
      ? `visual lore=${context.relevantLore
          .slice(0, 6)
          .map((item) => compact(item, 250))
          .join(' | ')}`
      : '',
    context.continuity?.seriesId
      ? `continuity series=${compact(context.continuity.seriesId, 100)}`
      : '',
    context.continuity?.previousPrompt
      ? `previous visual=${compact(context.continuity.previousPrompt, 700)}`
      : '',
    characters.length ? `recurring characters:\n${characters.join('\n')}` : '',
    recent.length ? `recent chat:\n${recent.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n')
    .slice(0, 3_500);
}

export function mediaFallbackHints(context?: MediaPromptContext): string[] {
  if (!context) return [];
  const characterHints = (context.continuity?.characters ?? [])
    .slice(0, 4)
    .map(
      (character) =>
        `${character.name}, ${character.visualDescription}` +
        (character.wardrobe ? `, ${character.wardrobe}` : ''),
    );
  return [
    context.groupAesthetic,
    context.desiredMood,
    context.continuity?.previousPrompt,
    ...characterHints,
  ]
    .filter((hint): hint is string => Boolean(hint?.trim()))
    .map((hint) => compact(hint, 500));
}

function compact(value: string, maxChars: number): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && character !== '\n' && character !== '\t' ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}
