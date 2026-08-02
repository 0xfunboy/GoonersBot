import { loadXFrontendConfig } from './frontend/x/config.js';
import { startXFrontend } from './frontend/x/runtime.js';

async function main(): Promise<void> {
  const config = await loadXFrontendConfig();
  const runtime = await startXFrontend(config);
  process.stdout.write(
    `${JSON.stringify({
      event: 'x_frontend_live',
      host: config.bindHost,
      port: config.noVncPort,
      authenticated: runtime.authenticated,
    })}\n`,
  );

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void runtime.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await runtime.stopped;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown startup failure';
  process.stderr.write(`${JSON.stringify({ event: 'x_frontend_failed', message })}\n`);
  process.exitCode = 1;
});
