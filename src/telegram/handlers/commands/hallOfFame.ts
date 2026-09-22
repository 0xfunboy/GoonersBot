import type { CommandResponse } from '../../../domain/types.js';
import type { CommandSpec, HandlerInput } from '../types.js';
import { Priority } from '../types.js';

/**
 * /halloffame (aliases /bestof, /perle)
 * Compiles community highlights, hilarious quotes, and running jokes into a comic Hall of Fame recap.
 */
export const hallOfFameCommand: CommandSpec = {
  command: 'halloffame',
  aliases: ['bestof', 'perle', 'topquotes'],
  permissions: ['allowed_user', 'not_banned'],
  needsTermsAccepted: true,
  priority: Priority.DEFAULT,
  quotaConversation: true,
  async handle({ services, context }: HandlerInput): Promise<CommandResponse | null> {
    const active = await services.lore.listActive(context.chatId, 80);

    if (active.length === 0) {
      return {
        rawText:
          '🏆 **Hall of Fame Vuota!**\n\nNon ci sono ancora perle, citazioni memorabili o deliri archiviati. ' +
          'Sparate qualche cazzata degna di nota prima di pretendere la gloria eterna!',
        textFormat: 'markdown',
      };
    }

    // Sort by positiveFeedbackCount * 3 + useCount + salience * 2, prioritizing quotes, running jokes, memes
    const scored = [...active]
      .map((item) => {
        let weight =
          (item.positiveFeedbackCount ?? 0) * 3 + (item.useCount ?? 0) + (item.salience ?? 1) * 2;
        if (item.category === 'quote' || item.subjectType === 'quote') weight += 5;
        if (item.category === 'running_joke' || item.subjectType === 'running_joke') weight += 4;
        if (item.category === 'meme' || item.subjectType === 'meme') weight += 3;
        return { item, weight };
      })
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10);

    const candidates = scored.map(({ item }) => {
      const author = item.subjectHandle ? `@${item.subjectHandle}` : 'Anonimo del gruppo';
      return `- [${item.category ?? 'perla'}] "${item.text}" (Autore/Soggetto: ${author}, salienza: ${item.salience})`;
    });

    try {
      const model = await services.modelForChat(context.chatId);
      const prompt = [
        'Sei GoonerBot, amico intimo, fedele e sfacciato di questo gruppo Telegram.',
        'Ecco le migliori perle, citazioni e ricordi memorizzati nella chat:',
        ...candidates,
        '',
        'Compila la leggendaria "🏆 HALL OF FAME DEL GRUPPO":',
        'Assegna titoli comici e satirici basandoti sulle citazioni fornite, ad esempio:',
        "- 👑 **La Perla d'Oro**",
        '- 🤡 **Il Delirio Assoluto**',
        "- 🔥 **Il Roast dell'Anno**",
        "- 🧪 **L'Hot Take Incomprensibile**",
        '',
        'Regole tassative:',
        '1. Sii naturale, affettuoso, ironico e divertente come un vero membro del gruppo.',
        '2. Cita gli utenti coinvolti usando i loro handle.',
        '3. Non essere un assistente formale: usa lo stile da bancone del bar tra veri amici.',
        '4. Mantieni la lunghezza compatta (massimo 4-5 nomination) e leggibile su Telegram in markdown.',
      ].join('\n');

      const res = await services.llm.chatCompletion({
        system: 'Sei GoonerBot, il cronista satirico e amico fidato della chat.',
        messages: [{ role: 'user', content: prompt }],
        ...(model ? { model } : {}),
        temperature: 0.7,
      });

      const text = res.text.trim();
      if (!text) {
        return {
          rawText: '🏆 **Hall of Fame del Gruppo**\n\n' + candidates.slice(0, 5).join('\n'),
          textFormat: 'markdown',
        };
      }

      return {
        rawText: text,
        textFormat: 'markdown',
      };
    } catch {
      // Fallback in case LLM call fails
      const fallbackList = scored
        .slice(0, 5)
        .map(
          ({ item }, i) =>
            `${i + 1}. *"${item.text}"* — ${item.subjectHandle ? `@${item.subjectHandle}` : 'Chat'}`,
        )
        .join('\n\n');

      return {
        rawText: `🏆 **Hall of Fame del Gruppo**\n\n${fallbackList}`,
        textFormat: 'markdown',
      };
    }
  },
};
