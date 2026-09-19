import { describe, expect, it } from 'vitest';
import { createDocument } from '../src/companion/artifacts/document.js';

describe('real document artifacts', () => {
  it('exports valid JSON and quoted CSV while preventing spreadsheet formula execution', async () => {
    const json = await createDocument({
      format: 'json',
      title: '../Dati riservati',
      content: '```json\n{"città":"Roma"}\n```',
    });
    expect(JSON.parse(json.buffer.toString())).toEqual({ città: 'Roma' });
    expect(json.name).toBe('Dati_riservati.json');
    const csv = await createDocument({
      format: 'csv',
      title: 'dati',
      content: JSON.stringify([
        ['nome', 'valore'],
        ['=HYPERLINK("https://example.org")', 'riga, "citata"'],
        ['costo', -15],
      ]),
    });
    expect(csv.buffer.toString()).toContain('"\'=HYPERLINK(""https://example.org"")"');
    expect(csv.buffer.toString()).toContain('"riga, ""citata"""');
    expect(csv.buffer.toString()).toContain('"-15"');
  });

  it('rejects truncated JSON and excessive document content before producing a file', async () => {
    await expect(
      createDocument({ format: 'json', title: 'broken', content: '{"value":' }),
    ).rejects.toThrow();
    await expect(
      createDocument({ format: 'markdown', title: 'large', content: 'a'.repeat(262_145) }),
    ).rejects.toThrow('size limit');
  });
});
