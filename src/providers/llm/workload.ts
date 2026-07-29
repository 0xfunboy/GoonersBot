import type {
  AutoEngageScore,
  ChatRequest,
  ChatResult,
  ImageRequest,
  ImageResult,
  JsonRequest,
  LLMProvider,
  ProviderCapabilities,
  ScoreAutoEngageRequest,
  TranscribeRequest,
  VisionRequest,
} from './types.js';

let interactiveInFlight = 0;
let lastInteractiveFinishedAt = 0;

function beginInteractive(): () => void {
  interactiveInFlight += 1;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    interactiveInFlight = Math.max(0, interactiveInFlight - 1);
    lastInteractiveFinishedAt = Date.now();
  };
}

async function interactive<T>(task: () => Promise<T>): Promise<T> {
  const finish = beginInteractive();
  try {
    return await task();
  } finally {
    finish();
  }
}

/**
 * Keep the low-priority miner off the router while an interactive operation is running and for a
 * short quiet window afterwards. Mining may be late; a person waiting in Telegram may not.
 */
export async function waitForInteractiveQuiet(
  quietMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const requiredQuiet = Number.isFinite(quietMs) ? Math.max(0, quietMs) : 0;
  for (;;) {
    if (signal?.aborted) throw abortReason(signal);
    const remainingQuiet = requiredQuiet - (Date.now() - lastInteractiveFinishedAt);
    if (interactiveInFlight === 0 && remainingQuiet <= 0) return;
    await abortableDelay(
      interactiveInFlight > 0 ? 250 : Math.min(1_000, Math.max(1, remainingQuiet)),
      signal,
    );
  }
}

/** Marks every foreground provider operation without changing the provider's routing semantics. */
export class InteractiveLLMProvider implements LLMProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  visionCompletion?: (req: VisionRequest) => Promise<ChatResult>;
  transcribeAudio?: (req: TranscribeRequest) => Promise<string>;
  generateImage?: (req: ImageRequest) => Promise<ImageResult>;
  embed?: (texts: string[]) => Promise<number[][]>;

  constructor(private readonly delegate: LLMProvider) {
    this.name = delegate.name;
    this.capabilities = delegate.capabilities;
    if (delegate.visionCompletion) {
      this.visionCompletion = (req) => interactive(() => delegate.visionCompletion!(req));
    }
    if (delegate.transcribeAudio) {
      this.transcribeAudio = (req) => interactive(() => delegate.transcribeAudio!(req));
    }
    if (delegate.generateImage) {
      this.generateImage = (req) => interactive(() => delegate.generateImage!(req));
    }
    if (delegate.embed) this.embed = (texts) => interactive(() => delegate.embed!(texts));
  }

  chatCompletion(req: ChatRequest): Promise<ChatResult> {
    return interactive(() => this.delegate.chatCompletion(req));
  }

  scoreAutoEngage(req: ScoreAutoEngageRequest): Promise<AutoEngageScore> {
    return interactive(() => this.delegate.scoreAutoEngage(req));
  }

  jsonCompletion<T>(req: JsonRequest<T>): Promise<T | null> {
    return interactive(() => this.delegate.jsonCompletion(req));
  }

  async *streamChatCompletion(req: ChatRequest): AsyncGenerator<string, ChatResult, void> {
    const finish = beginInteractive();
    try {
      return yield* this.delegate.streamChatCompletion(req);
    } finally {
      finish();
    }
  }
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = setTimeout(done, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortReason(signal));
    };
    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('operation aborted');
}
