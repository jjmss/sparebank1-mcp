import type { Config } from '../config.js';
import type { Sb1Tokens, Store } from '../store.js';

export class NotConnectedError extends Error {
  constructor(publicUrl: string) {
    super(
      `The server is not connected to SpareBank 1. Open ${publicUrl}/ in a browser and log in with BankID to connect it.`,
    );
    this.name = 'NotConnectedError';
  }
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

const EXPIRY_MARGIN_MS = 60_000;
const TIMEOUT_MS = 30_000;

/** Owns the SpareBank 1 OAuth tokens: the BankID code exchange, refreshing and storage. */
export class Sb1Auth {
  private refreshing?: Promise<string>;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isConnected(): boolean {
    return this.store.get().sb1 !== undefined;
  }

  /** Where to send the browser to log in with BankID. */
  authorizeUrl(state: string): string {
    const url = new URL('/oauth/authorize', this.config.sb1.apiBaseUrl);
    url.searchParams.set('client_id', this.config.sb1.clientId);
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', this.config.sb1.redirectUri);
    url.searchParams.set('response_type', 'code');
    if (this.config.sb1.finInst) url.searchParams.set('finInst', this.config.sb1.finInst);
    return url.toString();
  }

  /** Exchanges the single-use BankID authorization code (valid for two minutes). */
  async exchangeCode(code: string, state: string): Promise<void> {
    await this.requestTokens({
      grant_type: 'authorization_code',
      code,
      state,
      redirect_uri: this.config.sb1.redirectUri,
    });
  }

  async disconnect(): Promise<void> {
    await this.store.update((d) => {
      delete d.sb1;
    });
  }

  async getAccessToken(): Promise<string> {
    const tokens = this.store.get().sb1;
    if (!tokens) throw new NotConnectedError(this.config.publicUrl);
    const expired = tokens.expiresAt !== undefined && tokens.expiresAt - EXPIRY_MARGIN_MS <= Date.now();
    if (expired && tokens.refreshToken) return this.refresh();
    return tokens.accessToken;
  }

  /** Forces a refresh. Concurrent callers share one request, since refresh tokens are single-use. */
  refresh(): Promise<string> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  canRefresh(): boolean {
    return this.store.get().sb1?.refreshToken !== undefined;
  }

  private async doRefresh(): Promise<string> {
    const current = this.store.get().sb1;
    if (!current?.refreshToken) throw new NotConnectedError(this.config.publicUrl);
    const tokens = await this.requestTokens(
      { grant_type: 'refresh_token', refresh_token: current.refreshToken },
      current.refreshToken,
    );
    return tokens.accessToken;
  }

  private async requestTokens(params: Record<string, string>, previousRefreshToken?: string): Promise<Sb1Tokens> {
    const body = new URLSearchParams({
      client_id: this.config.sb1.clientId,
      client_secret: this.config.sb1.clientSecret,
      ...params,
    });
    const res = await this.fetchImpl(new URL('/oauth/token', this.config.sb1.apiBaseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The response body is deliberately not echoed: it can contain tokens.
    if (!res.ok) {
      const rejected = res.status === 400 || res.status === 401;
      if (rejected && params.grant_type === 'refresh_token') {
        // A rejected refresh token never becomes valid again; drop it so the
        // next call says "log in again" instead of failing the same way forever.
        await this.disconnect();
        throw new NotConnectedError(this.config.publicUrl);
      }
      throw new Error(`SpareBank 1 token endpoint answered ${res.status} for grant_type=${params.grant_type}`);
    }
    const json = (await res.json()) as TokenResponse;
    if (!json.access_token) throw new Error('SpareBank 1 token endpoint returned no access_token');

    const now = Date.now();
    const tokens: Sb1Tokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? previousRefreshToken,
      expiresAt: typeof json.expires_in === 'number' ? now + json.expires_in * 1000 : undefined,
      obtainedAt: now,
    };
    await this.store.update((d) => {
      d.sb1 = tokens;
    });
    return tokens;
  }
}
