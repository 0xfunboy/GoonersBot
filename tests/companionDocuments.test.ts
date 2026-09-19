import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDocument } from '../src/companion/artifacts/document.js';
import { runProcessChecked } from '../src/utils/process.js';

vi.mock('../src/utils/process.js', () => ({ runProcessChecked: vi.fn() }));
vi.mock('mammoth', () => ({ convertToHtml: vi.fn() }));

describe('real document artifacts', () => {
  beforeEach(() => vi.resetAllMocks());
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

  it.each(['[]', '{}', 'null', '```json\n[]\n```', '{"sections":[]}'])(
    'rejects narrative placeholders before conversion: %s',
    async (content) => {
      for (const format of ['pdf', 'docx', 'markdown', 'txt'] as const)
        await expect(createDocument({ format, title: 'checklist', content })).rejects.toThrow(
          'placeholder',
        );
      expect(runProcessChecked).not.toHaveBeenCalled();
    },
  );

  it.each(['[]', '{}', 'null'])('preserves legitimate JSON value %s', async (content) => {
    const document = await createDocument({ format: 'json', title: 'data', content });
    expect(JSON.parse(document.buffer.toString())).toEqual(JSON.parse(content));
  });

  it.each([
    ['[]', false],
    ['Scegli tema e ospiti.', false],
    ['Scegli tema e ospiti.\nRegistra una prova audio.\nPubblica e controlla il feed.', true],
  ] as const)('reopens the actual PDF and checks text coverage (%s)', async (actual, valid) => {
    vi.mocked(runProcessChecked).mockImplementation(async (bin, args) => {
      if (bin === 'libreoffice') {
        const directory = args[args.indexOf('--outdir') + 1]!;
        await writeFile(join(directory, 'report.pdf'), '%PDF-1.7 generated test fixture');
        return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
      }
      expect(bin).toBe('pdftotext');
      return { code: 0, stdout: Buffer.from(actual), stderr: '' };
    });
    const result = createDocument({
      format: 'pdf',
      title: 'Podcast',
      content: 'Scegli tema e ospiti.\nRegistra una prova audio.\nPubblica e controlla il feed.',
    });
    if (valid) expect((await result).verifiedText).toBe(actual);
    else await expect(result).rejects.toThrow('text verification failed');
    expect(runProcessChecked).toHaveBeenCalledTimes(2);
  });

  it('preserves DOCX line-break boundaries when checking words without punctuation', async () => {
    const mammoth = await import('mammoth');
    vi.mocked(mammoth.convertToHtml).mockResolvedValue({
      value: '<h1>Checklist</h1><p>Scegli tema<br>Registra prova<br>Pubblica episodio</p>',
      messages: [],
    });
    vi.mocked(runProcessChecked).mockImplementation(async (_bin, args) => {
      const directory = args[args.indexOf('--outdir') + 1]!;
      await writeFile(
        join(directory, 'report.docx'),
        Buffer.from('PK\x03\x04 generated test fixture'),
      );
      return { code: 0, stdout: Buffer.alloc(0), stderr: '' };
    });
    const document = await createDocument({
      format: 'docx',
      title: 'Checklist',
      content: '# Checklist\n\nScegli tema\nRegistra prova\nPubblica episodio',
    });
    expect(document.verifiedText).toContain('tema\nRegistra');
    expect(document.verifiedText).toContain('prova\nPubblica');
    expect(runProcessChecked).toHaveBeenCalledOnce();
  });
});
