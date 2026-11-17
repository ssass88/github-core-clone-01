// GitForge Core Process Entrypoint & make.fun Harness Coordinator
// Authored by @ssass88 for github-core-clone-01 bounty

import { createApp } from './app.ts';

const targetEnvOrigin = (process.env.MAKEFUN_ENV_URL ?? '').trim().replace(/\/+$/, '');
if (!targetEnvOrigin) {
  process.stderr.write('[gitforge-core] Fatal: Missing MAKEFUN_ENV_URL environment variable.\n');
  process.exit(1);
}

const MAX_CALL_TIMEOUT_MS = 25_000;
const INITIAL_BACKOFF_MS = 200;
const MAXIMUM_BACKOFF_MS = 2_500;

function computeDelay(retryCount: number): number {
  const scaled = INITIAL_BACKOFF_MS * Math.pow(2, Math.min(retryCount, 7));
  return Math.min(MAXIMUM_BACKOFF_MS, scaled);
}

const pauseExecution = (duration: number): Promise<void> =>
  new Promise((proceed) => setTimeout(proceed, duration));

async function announcePortToHarness(allocatedPort: number): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      const response = await fetch(`${targetEnvOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: allocatedPort }),
        signal: AbortSignal.timeout(MAX_CALL_TIMEOUT_MS),
      });

      if (response.status === 200 || response.status === 409) {
        process.stdout.write(`[gitforge-core] Successfully registered port ${allocatedPort} (HTTP ${response.status})\n`);
        return;
      }

      if (response.status === 400 || response.status === 405) {
        const errorText = await response.text();
        throw new Error(`Register failed with protocol rejection: HTTP ${response.status} - ${errorText}`);
      }
    } catch (failure) {
      if (failure instanceof Error && failure.message.includes('protocol rejection')) {
        throw failure;
      }
    }

    attempt += 1;
    await pauseExecution(computeDelay(attempt));
  }
}

async function awaitHarnessCompletion(): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      const pollResponse = await fetch(`${targetEnvOrigin}/done`, {
        signal: AbortSignal.timeout(MAX_CALL_TIMEOUT_MS),
      });

      if (pollResponse.ok) {
        const parsedPayload = (await pollResponse.json()) as { done?: unknown };
        if (parsedPayload.done === true) {
          process.stdout.write('[gitforge-core] Test suite completion confirmed by harness.\n');
          return;
        }
      }
    } catch {
      // Env server still executing benchmark tests or warming up
    }

    attempt += 1;
    await pauseExecution(computeDelay(attempt));
  }
}

async function bootForge(): Promise<void> {
  const forgeApp = createApp();

  await new Promise<void>((resolveBoot, rejectBoot) => {
    forgeApp.once('error', rejectBoot);
    forgeApp.listen(0, () => resolveBoot());
  });

  const boundAddress = forgeApp.address();
  if (!boundAddress || typeof boundAddress === 'string') {
    throw new Error('[gitforge-core] Failed to bind an ephemeral TCP port');
  }

  const assignedPort = boundAddress.port;
  process.stdout.write(`[gitforge-core] HTTP service active on 127.0.0.1:${assignedPort}\n`);

  await announcePortToHarness(assignedPort);
  await awaitHarnessCompletion();

  forgeApp.close();
  process.stdout.write('[gitforge-core] Clean process shutdown complete.\n');
}

try {
  await bootForge();
  process.exit(0);
} catch (startupError) {
  process.stderr.write(`[gitforge-core] Unhandled startup error: ${startupError}\n`);
  process.exit(1);
}
