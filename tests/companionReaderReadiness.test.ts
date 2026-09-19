import { describe, expect, it } from 'vitest';
import { DocumentOcr } from '../src/documents/ocr.js';
import { renderPublicPage, renderedPageReadiness } from '../src/search/renderedPage.js';

describe('optional local reader readiness', () => {
  it('does not claim OCR when disabled or missing, and never uploads documents as fallback', async () => {
    expect(await new DocumentOcr({ enabled: false }).status()).toMatchObject({
      enabled: false,
      images: false,
      pdf: false,
    });
    const unavailable = new DocumentOcr({
      enabled: true,
      tesseractCommand: '/nonexistent-goonerbot-reader/tesseract',
    });
    expect(await unavailable.status()).toMatchObject({ enabled: true, images: false, pdf: false });
    await expect(unavailable.extract(Buffer.from('data'), 'image/png')).rejects.toThrow(
      'unavailable',
    );
  });

  it('fails closed before network or browser launch without explicit enablement and actual binaries', async () => {
    expect(await renderedPageReadiness({ enabled: false })).toMatchObject({ ready: false });
    expect(
      await renderedPageReadiness({
        enabled: true,
        chromiumCommand: '/nonexistent-goonerbot-reader/chromium',
      }),
    ).toMatchObject({ ready: false, reason: expect.stringContaining('unavailable') });
    await expect(renderPublicPage('http://127.0.0.1/secret', { enabled: false })).rejects.toThrow(
      'disabled',
    );
    expect(
      await renderedPageReadiness({ enabled: true, chromiumCommand: 'user-provided-command' }),
    ).toMatchObject({ ready: false, reason: expect.stringContaining('absolute') });
  });
});
