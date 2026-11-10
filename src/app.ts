import { join } from 'node:path';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import { McpOAuthProvider } from './oauth-provider.js';
import { consentPage, homePage, messagePage } from './pages.js';
import { AttemptLimiter, ExpiringMap, randomToken, safeEqual } from './security.js';
import { Sb1Auth } from './sparebank1/auth.js';
import { Sb1Client } from './sparebank1/client.js';
import { Store } from './store.js';
import { createMcpServer } from './tools.js';

export interface App {
  app: Express;
  store: Store;
}

export async function createApp(config: Config, fetchImpl: typeof fetch = fetch): Promise<App> {
  const store = await Store.open(join(config.dataDir, 'store.json'), config.encryptionKey);
  const sb1Auth = new Sb1Auth(config, store, fetchImpl);
  const sb1Client = new Sb1Client(config.sb1.apiBaseUrl, sb1Auth, fetchImpl);
  const provider = new McpOAuthProvider(store, config.staticToken);
  const limiter = new AttemptLimiter();
  /** BankID logins in flight. A callback is only accepted for a state this server handed out. */
  const bankIdStates = new ExpiringMap<true>(10 * 60_000, 20);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    });
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // OAuth 2.1 for MCP clients: metadata, dynamic client registration, /authorize, /token, /revoke.
  const mcpUrl = new URL(config.mcpUrl);
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.publicUrl),
      resourceServerUrl: mcpUrl,
      resourceName: 'SpareBank 1 MCP',
    }),
  );

  const form = express.urlencoded({ extended: false, limit: '10kb' });

  /** Checks the admin password from a form post. Answers the request itself and returns false if it is wrong. */
  function passwordOk(req: Request, res: Response, onWrong: (message: string) => string): boolean {
    const password: unknown = (req.body as Record<string, unknown> | undefined)?.password;
    if (limiter.blocked()) {
      res.status(429).type('html').send(onWrong('For mange forsøk. Vent 15 minutter og prøv igjen.'));
      return false;
    }
    if (typeof password !== 'string' || !safeEqual(password, config.adminPassword)) {
      limiter.recordFailure();
      console.warn(`[auth] wrong admin password on ${req.path} from ${req.ip}`);
      res.status(401).type('html').send(onWrong('Feil passord.'));
      return false;
    }
    return true;
  }

  // The consent page posts here. Only the owner's password turns a pending request into a code.
  app.post('/authorize/approve', form, (req, res) => {
    const requestId: unknown = (req.body as Record<string, unknown> | undefined)?.request;
    const pending = typeof requestId === 'string' ? provider.pending.get(requestId) : undefined;
    if (typeof requestId !== 'string' || !pending) {
      res
        .status(400)
        .type('html')
        .send(messagePage('Forespørselen er utløpt', 'Start tilkoblingen på nytt fra MCP-klienten.'));
      return;
    }
    const again = (error: string) =>
      consentPage({ requestId, client: pending.client, redirectUri: pending.params.redirectUri, error });
    if (!passwordOk(req, res, again)) return;
    provider.pending.take(requestId);
    console.info(`[auth] MCP client approved: ${pending.client.client_name ?? pending.client.client_id}`);
    res.redirect(302, provider.approve(pending));
  });

  const home = (error?: string) => homePage({ redirectUri: config.sb1.redirectUri, mcpUrl: config.mcpUrl, error });

  app.get('/', (_req, res) => {
    res.type('html').send(home());
  });

  // Connecting to the bank: password -> BankID at SpareBank 1 -> callback with a single-use code.
  app.post('/sparebank1/login', form, (req, res) => {
    if (!passwordOk(req, res, home)) return;
    const state = randomToken();
    bankIdStates.set(state, true);
    res.redirect(302, sb1Auth.authorizeUrl(state));
  });

  app.get('/sparebank1/callback', async (req, res) => {
    const { code, state } = req.query;
    if (typeof code !== 'string' || typeof state !== 'string' || !bankIdStates.take(state)) {
      res
        .status(400)
        .type('html')
        .send(messagePage('Innlogging feilet', 'Ugyldig eller utløpt forespørsel. Start innloggingen på nytt.'));
      return;
    }
    try {
      await sb1Auth.exchangeCode(code, state);
      console.info('[sb1] connected to SpareBank 1');
      res.type('html').send(messagePage('Koblet til', 'Serveren er nå koblet til SpareBank 1. Du kan lukke siden.'));
    } catch (err) {
      console.error('[sb1] code exchange failed:', err instanceof Error ? err.message : err);
      res
        .status(502)
        .type('html')
        .send(
          messagePage(
            'Innlogging feilet',
            'SpareBank 1 avviste forespørselen. Sjekk client id, client secret og at redirect-URI er registrert ' +
              'nøyaktig som vist på forsiden, og prøv igjen.',
          ),
        );
    }
  });

  app.post('/admin/revoke', form, async (req, res) => {
    if (!passwordOk(req, res, home)) return;
    await sb1Auth.disconnect();
    await provider.revokeAll();
    console.warn('[auth] bank token removed and all MCP clients signed out');
    res
      .type('html')
      .send(messagePage('Koblet fra', 'Bank-tokenet er fjernet fra serveren og alle MCP-klienter er logget ut.'));
  });

  // The MCP endpoint itself. Stateless: every request gets a fresh server and transport.
  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });

  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req, res) => {
    const server = createMcpServer(sb1Client, { enableTransfers: config.sb1.enableTransfers });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
  };
  app.get('/mcp', bearer, methodNotAllowed);
  app.delete('/mcp', bearer, methodNotAllowed);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[http] unhandled error:', err instanceof Error ? err.message : err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error' });
  });

  return { app, store };
}
