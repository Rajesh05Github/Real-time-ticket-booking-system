import { buildApp } from './app.js';
import { env } from './env.js';
import { registerGracefulShutdown } from './shutdown.js';

async function main(): Promise<void> {
  const app = await buildApp();

  registerGracefulShutdown(app, env.SHUTDOWN_TIMEOUT_MS);

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((err: unknown) => {
  console.error('[api] fatal error during startup', err);
  process.exit(1);
});
