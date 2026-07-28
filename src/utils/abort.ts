export interface AbortScope {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

/**
 * Combine a host cancellation signal with a local timeout and clean up listeners deterministically.
 */
export function createAbortScope(
  timeoutMs: number,
  externalSignal?: AbortSignal,
  label = 'operation',
): AbortScope {
  const controller = new AbortController();
  let timeoutTriggered = false;
  const abortFromExternal = (): void => {
    controller.abort(externalSignal?.reason ?? new Error(`${label} aborted`));
  };
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });

  const timer = setTimeout(
    () => {
      timeoutTriggered = true;
      controller.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
    },
    Math.max(1, timeoutMs),
  );

  return {
    signal: controller.signal,
    timedOut: () => timeoutTriggered,
    dispose: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    },
  };
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error('operation aborted');
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('operation aborted'));
    };
    function finish(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
