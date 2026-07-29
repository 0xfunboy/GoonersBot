import { describe, expect, it, vi } from 'vitest';
import {
  markdownToTelegramHtml,
  renderTelegramText,
  splitTelegramMarkdown,
  telegramPlainText,
} from '../src/telegram/format.js';
import { sendResponse } from '../src/telegram/render.js';

describe('Telegram formatting', () => {
  it('converts the CommonMark emitted in real answers into Telegram HTML', () => {
    const rendered = markdownToTelegramHtml(
      '1. **Articolo 1**\n_Nota_: `2 < 3` — [fonte](https://example.com/a?x=1&y=2)',
    );

    expect(rendered).toBe(
      '1. <b>Articolo 1</b>\n<i>Nota</i>: <code>2 &lt; 3</code> — ' +
        '<a href="https://example.com/a?x=1&amp;y=2">fonte</a>',
    );
  });

  it('escapes model HTML and preserves ordinary underscores and ampersands', () => {
    const rendered = markdownToTelegramHtml(
      '<script>no</script> @foo_bar file_name Bisp&d https://example.com/a_b',
    );

    expect(rendered).toBe(
      '&lt;script&gt;no&lt;/script&gt; @foo_bar file_name Bisp&amp;d https://example.com/a_b',
    );
  });

  it('leaves incomplete delimiters visible without producing invalid HTML', () => {
    expect(markdownToTelegramHtml('**aperto e _pure questo')).toBe('**aperto e _pure questo');
  });

  it('supports headings, bullets, quotes, spoilers and fenced code', () => {
    const rendered = markdownToTelegramHtml(
      '# Titolo\n- voce\n> citazione\n||segreto||\n```ts\nconst x = 2 < 3;\n```',
    );

    expect(rendered).toContain('<b>Titolo</b>');
    expect(rendered).toContain('• voce');
    expect(rendered).toContain('<blockquote>citazione</blockquote>');
    expect(rendered).toContain('<tg-spoiler>segreto</tg-spoiler>');
    expect(rendered).toContain('<pre>const x = 2 &lt; 3;</pre>');
  });

  it('balances a fenced code block split across Telegram messages', () => {
    const source = `Intro\n\n\`\`\`txt\n${'riga di codice\n'.repeat(100)}\`\`\`\n\nFine`;
    const chunks = splitTelegramMarkdown(source, 300);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => (chunk.match(/^\s*```[^\n]*$/gm) ?? []).length % 2 === 0)).toBe(
      true,
    );
    expect(chunks.every((chunk) => chunk.length <= 300)).toBe(true);
  });

  it('produces a readable fallback without leaking markup or entities', () => {
    expect(telegramPlainText('<strong>Uso:</strong> /play &lt;brano&gt;', 'html')).toBe(
      'Uso: /play <brano>',
    );
    expect(telegramPlainText('**forte** & _chiaro_', 'markdown')).toBe('forte & chiaro');
  });

  it('escapes plain text while leaving intentional HTML untouched', () => {
    expect(renderTelegramText('2 < 3 & 4', 'plain').text).toBe('2 &lt; 3 &amp; 4');
    expect(renderTelegramText('<strong>ok</strong>', 'html').text).toBe('<strong>ok</strong>');
  });
});

describe('formatted media delivery', () => {
  it('retries the same media with a plain caption when Telegram rejects formatted entities', async () => {
    const replyWithPhoto = vi
      .fn()
      .mockRejectedValueOnce(new Error("can't parse entities"))
      .mockResolvedValueOnce({ message_id: 9 });
    const ctx = {
      message: { message_id: 3 },
      replyWithPhoto,
      reply: vi.fn(),
    };

    const sent = await sendResponse(ctx as never, {
      imageBuffer: Buffer.from('image'),
      text: '**Risultato** & dettagli',
      textFormat: 'markdown',
    });

    expect(sent?.message_id).toBe(9);
    expect(replyWithPhoto).toHaveBeenCalledTimes(2);
    expect(replyWithPhoto.mock.calls[0]?.[1]).toMatchObject({
      caption: '<b>Risultato</b> &amp; dettagli',
      parse_mode: 'HTML',
    });
    expect(replyWithPhoto.mock.calls[1]?.[1]).toMatchObject({
      caption: 'Risultato & dettagli',
    });
    expect(replyWithPhoto.mock.calls[1]?.[1]).not.toHaveProperty('parse_mode');
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it('keeps long media text out of the caption and delivers it separately', async () => {
    const replyWithPhoto = vi.fn().mockResolvedValue({ message_id: 10 });
    const reply = vi.fn().mockResolvedValue({ message_id: 11 });
    const ctx = {
      message: { message_id: 4 },
      replyWithPhoto,
      reply,
    };
    const text = `**Report** ${'dettaglio '.repeat(130)}`.trim();

    await sendResponse(ctx as never, {
      imageBuffer: Buffer.from('image'),
      text,
      textFormat: 'markdown',
    });

    expect(replyWithPhoto.mock.calls[0]?.[1]).not.toHaveProperty('caption');
    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('<b>Report</b>'),
      expect.objectContaining({ parse_mode: 'HTML' }),
    );
  });

  it('does not retry media after a non-format transport failure', async () => {
    const replyWithPhoto = vi.fn().mockRejectedValue(new Error('network timeout'));
    const reply = vi.fn().mockResolvedValue({ message_id: 12 });
    const ctx = {
      message: { message_id: 5 },
      replyWithPhoto,
      reply,
    };

    await sendResponse(ctx as never, {
      imageBuffer: Buffer.from('image'),
      text: '**Risultato**',
      textFormat: 'markdown',
    });

    expect(replyWithPhoto).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledWith(
      'Risultato',
      expect.objectContaining({ reply_parameters: { message_id: 5 } }),
    );
  });

  it('splits a long formatted command response without losing its content', async () => {
    const reply = vi.fn().mockResolvedValue({ message_id: 13 });
    const ctx = {
      message: { message_id: 6 },
      reply,
    };
    const text = `**Titolo**\n\n${'contenuto utile '.repeat(350)}`.trim();

    await sendResponse(ctx as never, { text, textFormat: 'markdown' });

    expect(reply.mock.calls.length).toBeGreaterThan(1);
    expect(reply.mock.calls[0]?.[0]).toContain('<b>Titolo</b>');
    expect(reply.mock.calls.every((call) => call[1]?.parse_mode === 'HTML')).toBe(true);
  });
});
