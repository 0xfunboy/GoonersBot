import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAbortScope } from '../utils/abort.js';
import { runProcess, runProcessChecked } from '../utils/process.js';

export interface DocumentOcrConfig {
  enabled: boolean;
  tesseractCommand?: string;
  pdfRendererCommand?: string;
  language?: string;
  maxPages?: number;
}

export interface OcrReadiness {
  enabled: boolean;
  images: boolean;
  pdf: boolean;
  reason?: string;
}

/** Local, opt-in OCR. No upload, embedded-object execution, shell, or persistent process. */
export class DocumentOcr {
  private readiness?: Promise<OcrReadiness>;

  constructor(private readonly config: DocumentOcrConfig) {}

  get maxPages(): number {
    return Math.min(5, Math.max(1, this.config.maxPages ?? 3));
  }

  status(): Promise<OcrReadiness> {
    this.readiness ??= this.checkReadiness();
    return this.readiness;
  }

  private async checkReadiness(): Promise<OcrReadiness> {
    if (!this.config.enabled)
      return {
        enabled: false,
        images: false,
        pdf: false,
        reason: 'OCR is disabled by host configuration',
      };
    const probe = async (bin: string, args: string[]): Promise<boolean> => {
      try {
        return (await runProcess(bin, args, { timeoutMs: 5000, maxStderrBytes: 4096 })).code === 0;
      } catch {
        return false;
      }
    };
    let images = await probe(this.config.tesseractCommand ?? 'tesseract', ['--version']);
    const language = this.config.language ?? 'eng';
    if (!/^[a-zA-Z0-9_]+(?:\+[a-zA-Z0-9_]+)*$/u.test(language))
      return {
        enabled: true,
        images: false,
        pdf: false,
        reason: 'Configured OCR language is invalid',
      };
    if (images) {
      try {
        const installed = await runProcess(
          this.config.tesseractCommand ?? 'tesseract',
          ['--list-langs'],
          { timeoutMs: 5000, collectStdout: true, maxStdoutBytes: 16_384, maxStderrBytes: 4096 },
        );
        const languages = new Set(
          installed.stdout
            .toString('utf8')
            .split(/\r?\n/u)
            .map((line) => line.trim()),
        );
        images = installed.code === 0 && language.split('+').every((part) => languages.has(part));
        if (!images)
          return {
            enabled: true,
            images: false,
            pdf: false,
            reason: 'Configured OCR language data is unavailable',
          };
      } catch {
        return {
          enabled: true,
          images: false,
          pdf: false,
          reason: 'OCR language readiness could not be verified',
        };
      }
    }
    const pdf = images && (await probe(this.config.pdfRendererCommand ?? 'pdftoppm', ['-v']));
    return {
      enabled: true,
      images,
      pdf,
      ...(!images
        ? {
            reason: 'Tesseract executable is unavailable; install/configure it before enabling OCR',
          }
        : !pdf
          ? { reason: 'PDF rasterizer is unavailable; only image OCR is ready' }
          : {}),
    };
  }

  async extract(
    buffer: Buffer,
    mime: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; pages: number }> {
    if (buffer.length > 20 * 1024 * 1024) throw new Error('OCR input exceeds 20 MiB');
    const pdf = mime === 'application/pdf';
    const readiness = await this.status();
    if (!(pdf ? readiness.pdf : readiness.images))
      throw new Error(readiness.reason ?? 'OCR is unavailable');
    if (!pdf && !['image/png', 'image/jpeg', 'image/webp', 'image/tiff'].includes(mime))
      throw new Error('Unsupported OCR image type');
    const language = this.config.language ?? 'eng';
    if (!/^[a-zA-Z0-9_]+(?:\+[a-zA-Z0-9_]+)*$/u.test(language))
      throw new Error('Invalid configured OCR language');
    const directory = await mkdtemp(join(tmpdir(), 'goonerbot-ocr-'));
    const scope = createAbortScope(90_000, signal, 'document OCR');
    try {
      const input = join(directory, pdf ? 'input.pdf' : 'input.image');
      await writeFile(input, buffer, { mode: 0o600 });
      let images = [input];
      if (pdf) {
        await runProcessChecked(
          this.config.pdfRendererCommand ?? 'pdftoppm',
          [
            '-f',
            '1',
            '-l',
            String(this.maxPages),
            '-scale-to',
            '1800',
            '-gray',
            '-png',
            input,
            join(directory, 'page'),
          ],
          {
            timeoutMs: 35_000,
            signal: scope.signal,
            maxFileBytes: 8 * 1024 * 1024,
            maxRssBytes: 512 * 1024 * 1024,
          },
          'PDF OCR rasterizer',
        );
        images = (await readdir(directory))
          .filter((name) => /^page-\d+\.png$/u.test(name))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .slice(0, this.maxPages)
          .map((name) => join(directory, name));
        if (!images.length) throw new Error('PDF rasterizer produced no pages');
      }
      const text: string[] = [];
      for (const [index, image] of images.entries()) {
        scope.signal.throwIfAborted();
        // Verify raster size independently of the child RLIMIT before handing it to OCR.
        if (pdf && (await stat(image)).size > 8 * 1024 * 1024)
          throw new Error('OCR raster exceeds its size budget');
        const result = await runProcessChecked(
          this.config.tesseractCommand ?? 'tesseract',
          [image, 'stdout', '-l', language],
          {
            timeoutMs: 30_000,
            signal: scope.signal,
            collectStdout: true,
            maxStdoutBytes: 512 * 1024,
            maxRssBytes: 512 * 1024 * 1024,
          },
          'document OCR',
        );
        text.push(
          `${pdf ? `[OCR page ${index + 1}]\n` : ''}${result.stdout.toString('utf8').trim()}`,
        );
      }
      return { text: text.join('\n\n'), pages: images.length };
    } finally {
      scope.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  }
}
