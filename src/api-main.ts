#!/usr/bin/env node
import { startApiServer } from './api.js';

async function main(): Promise<void> {
  const { server, host, port } = await startApiServer();
  process.stdout.write(`Mai API listening on http://${host}:${port}\n`);

  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  process.stderr.write(`Failed to start Mai API: ${(err as Error).message}\n`);
  process.exit(1);
});
