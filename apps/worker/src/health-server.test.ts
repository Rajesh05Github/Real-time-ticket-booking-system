import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startHealthServer } from './health-server.js';

import type { Logger } from '@flashsale/logger';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

// A different, fixed, high, unlikely-to-collide port PER TEST -- simpler
// than plumbing an OS-assigned ephemeral port back out of
// `startHealthServer` (which deliberately exposes only `{ stop }` to its
// real caller, index.ts), and avoids any same-port reuse race between
// one test's teardown and the next test's startup.
describe('startHealthServer', () => {
  let server: ReturnType<typeof startHealthServer> | undefined;

  beforeEach(() => {
    // Otherwise `vi.waitFor(() => expect(silentLogger.info).toHaveBeenCalled())`
    // below can resolve instantly off a PREVIOUS test's call, before
    // THIS test's own server has actually finished binding.
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
  });

  it('responds 200 {"status":"ok"} on GET /health', async () => {
    const port = 41_777;
    server = startHealthServer(port, silentLogger);
    await vi.waitFor(() => expect(silentLogger.info).toHaveBeenCalledWith({ port }, 'worker health server listening'));

    const response = await fetch(`http://127.0.0.1:${port}/health`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('responds 404 to anything else', async () => {
    const port = 41_778;
    server = startHealthServer(port, silentLogger);
    await vi.waitFor(() => expect(silentLogger.info).toHaveBeenCalled());

    const response = await fetch(`http://127.0.0.1:${port}/whatever`);

    expect(response.status).toBe(404);
  });

  it('stop() closes the server -- a subsequent request fails to connect', async () => {
    const port = 41_779;
    server = startHealthServer(port, silentLogger);
    await vi.waitFor(() => expect(silentLogger.info).toHaveBeenCalled());

    await server.stop();
    server = undefined;

    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
