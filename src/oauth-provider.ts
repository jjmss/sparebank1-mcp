import type { Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { ExpiringMap, randomToken, safeEqual, sha256 } from './security.js';
import type { Store } from './store.js';
import { consentPage } from './pages.js';

const ACCESS_TOKEN_TTL_S = 60 * 60;
const REFRESH_TOKEN_TTL_MS = 60 * 24 * 60 * 60_000;
const MAX_CLIENTS = 50;

export interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
}

interface IssuedCode {
  clientId: string;
  params: AuthorizationParams;
}

interface AccessToken {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

/**
 * The OAuth 2.1 authorization server MCP clients (such as Claude's custom
 * connectors) talk to. It has exactly one user: whoever knows ADMIN_PASSWORD.
 *
 * Anyone can register a client and start a flow, which is how MCP clients are
 * meant to work, but no token is issued until the password has been entered on
 * the consent page. Tokens are stored only as hashes.
 */
export class McpOAuthProvider implements OAuthServerProvider {
  /** Authorization requests waiting for the owner to approve them on the consent page. */
  readonly pending = new ExpiringMap<PendingAuthorization>(10 * 60_000);
  private readonly codes = new ExpiringMap<IssuedCode>(2 * 60_000);
  private readonly accessTokens = new ExpiringMap<AccessToken>(ACCESS_TOKEN_TTL_S * 1000, 10_000);

  constructor(
    private readonly store: Store,
    private readonly staticToken?: string,
  ) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.store.get().clients[clientId],
      registerClient: async (client) => {
        const full = client as OAuthClientInformationFull;
        await this.store.update((d) => {
          // Registration is open, so cap it. Clients that hold a grant are kept.
          const ids = Object.keys(d.clients);
          if (ids.length >= MAX_CLIENTS) {
            const inUse = new Set(Object.values(d.grants).map((g) => g.clientId));
            const victim = ids.find((id) => !inUse.has(id)) ?? ids[0];
            if (victim !== undefined) delete d.clients[victim];
          }
          d.clients[full.client_id] = full;
        });
        return full;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = randomToken();
    this.pending.set(id, { client, params });
    res.status(200).type('html').send(consentPage({ requestId: id, client, redirectUri: params.redirectUri }));
  }

  /** Called once the owner has approved a pending request. Returns where to send the browser. */
  approve(request: PendingAuthorization): string {
    const code = randomToken();
    this.codes.set(code, { clientId: request.client.client_id, params: request.params });
    const target = new URL(request.params.redirectUri);
    target.searchParams.set('code', code);
    if (request.params.state !== undefined) target.searchParams.set('state', request.params.state);
    return target.toString();
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const issued = this.codes.get(code);
    if (!issued || issued.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return issued.params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const issued = this.codes.take(code);
    if (!issued || issued.clientId !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    if (redirectUri !== undefined && redirectUri !== issued.params.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    return this.issue(client.client_id, issued.params.scopes ?? [], issued.params.resource?.toString());
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const key = sha256(refreshToken);
    const grant = this.store.get().grants[key];
    if (!grant || grant.clientId !== client.client_id || grant.expiresAt <= Date.now()) {
      throw new InvalidGrantError('Invalid refresh token');
    }
    // Refresh tokens rotate: the old one stops working as the new one is issued.
    return this.issue(client.client_id, grant.scopes, grant.resource, key);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    if (this.staticToken !== undefined && safeEqual(token, this.staticToken)) {
      return { token, clientId: 'static-token', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 60 };
    }
    const found = this.accessTokens.get(sha256(token));
    if (!found) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: found.clientId,
      scopes: found.scopes,
      expiresAt: Math.floor(found.expiresAt / 1000),
      resource: found.resource ? new URL(found.resource) : undefined,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = sha256(request.token);
    const access = this.accessTokens.get(key);
    if (access?.clientId === client.client_id) this.accessTokens.take(key);
    if (this.store.get().grants[key]?.clientId === client.client_id) {
      await this.store.update((d) => {
        delete d.grants[key];
      });
    }
  }

  /** Signs every MCP client out. They have to go through the consent page again. */
  async revokeAll(): Promise<void> {
    this.accessTokens.clear();
    await this.store.update((d) => {
      d.grants = {};
      d.clients = {};
    });
  }

  private async issue(clientId: string, scopes: string[], resource?: string, replaces?: string): Promise<OAuthTokens> {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    const now = Date.now();
    this.accessTokens.set(sha256(accessToken), {
      clientId,
      scopes,
      resource,
      expiresAt: now + ACCESS_TOKEN_TTL_S * 1000,
    });
    await this.store.update((d) => {
      if (replaces !== undefined) delete d.grants[replaces];
      for (const [key, grant] of Object.entries(d.grants)) if (grant.expiresAt <= now) delete d.grants[key];
      d.grants[sha256(refreshToken)] = { clientId, scopes, resource, expiresAt: now + REFRESH_TOKEN_TTL_MS };
    });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }
}
