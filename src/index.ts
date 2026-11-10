import { loadConfig } from './config.js';
import { createApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app } = await createApp(config);

  const server = app.listen(config.port, config.host, () => {
    console.info(`[http] listening on ${config.host}:${config.port}`);
    console.info(`[http] MCP endpoint: ${config.mcpUrl}`);
    console.info(`[sb1] redirect URI to register with SpareBank 1: ${config.sb1.redirectUri}`);
    console.info(`[sb1] transfers are ${config.sb1.enableTransfers ? 'ENABLED' : 'disabled'}`);
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  }
}

main().catch((err: unknown) => {
  // Configuration errors name the variable, never its value.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
