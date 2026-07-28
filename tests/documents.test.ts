import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentProcessor } from '../src/documents/documentProcessor.js';
import type { MessageAttachment } from '../src/domain/types.js';
import { buildIncomingMessage } from '../src/telegram/context.js';
import type { Context } from 'grammy';

const processor = new DocumentProcessor({
  enabled: true,
  maxCharsPerFile: 2_000,
  maxFilesPerTurn: 3,
});

afterEach(() => vi.unstubAllGlobals());

function attachment(
  buffer: Buffer,
  fileName: string,
  mime: string,
  source: MessageAttachment['source'] = 'reply',
): MessageAttachment {
  return { buffer, fileName, mime, size: buffer.byteLength, source };
}

describe('DocumentProcessor', () => {
  it('extracts replied plain-text documents and preserves provenance', async () => {
    const result = await processor.extract(
      attachment(Buffer.from('Titolo\n\nContenuto importante.'), 'notes.md', 'text/markdown'),
    );
    expect(result).toMatchObject({
      fileName: 'notes.md',
      source: 'reply',
      text: 'Titolo\n\nContenuto importante.',
      truncated: false,
    });
    expect(processor.formatForPrompt(result ? [result] : [])).toContain(
      'name="notes.md" source=reply',
    );
  });

  it('removes executable HTML elements while retaining visible content', async () => {
    const result = await processor.extract(
      attachment(
        Buffer.from('<h1>Report</h1><script>steal()</script><p>42 vendite</p>'),
        'report.html',
        'text/html',
        'current',
      ),
    );
    expect(result?.text).toContain('Report');
    expect(result?.text).toContain('42 vendite');
    expect(result?.text).not.toContain('steal');
  });

  it('extracts selectable text from a PDF', async () => {
    const result = await processor.extract(
      attachment(makePdf('Hello from the replied PDF'), 'brief.pdf', 'application/pdf'),
    );
    expect(result?.text).toContain('Hello from the replied PDF');
    expect(result?.pages).toBe(1);
  });

  it('ignores unsupported binary files instead of injecting garbage', async () => {
    await expect(
      processor.extract(
        attachment(Buffer.from([0, 1, 2, 3]), 'archive.bin', 'application/octet-stream'),
      ),
    ).resolves.toBeNull();
  });

  it('downloads a document from the replied-to Telegram message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(Buffer.from('replied PDF bytes'), { status: 200 })),
    );
    const ctx = {
      message: {
        date: 1_700_000_000,
        reply_to_message: {
          document: {
            file_id: 'pdf-file',
            file_unique_id: 'unique',
            file_name: 'reply.pdf',
            mime_type: 'application/pdf',
            file_size: 17,
          },
        },
      },
      api: {
        token: 'secret',
        getFile: vi.fn().mockResolvedValue({
          file_id: 'pdf-file',
          file_unique_id: 'unique',
          file_path: 'documents/reply.pdf',
          file_size: 17,
        }),
      },
    } as unknown as Context;
    const message = await buildIncomingMessage(ctx, {
      image: true,
      voice: true,
      documents: true,
    });
    expect(message.attachments).toEqual([
      expect.objectContaining({
        fileName: 'reply.pdf',
        mime: 'application/pdf',
        source: 'reply',
        buffer: Buffer.from('replied PDF bytes'),
      }),
    ]);
  });
});

function makePdf(text: string): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length + 33} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
