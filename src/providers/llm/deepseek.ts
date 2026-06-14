import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from './openaiCompatible.js';

/**
 * DeepSeek is OpenAI-compatible for chat. It does not provide vision/image/transcription on the
 * standard API, so those capabilities stay false unless explicitly configured with compatible
 * model names (rare). This subclass exists mainly for a clear provider name + future tuning.
 */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(opts: Omit<OpenAICompatibleOptions, 'name'>) {
    super({ ...opts, name: 'deepseek' });
  }
}
