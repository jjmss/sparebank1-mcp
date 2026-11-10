import type { Sb1Auth } from './auth.js';

/** The APIs are versioned through the media type rather than the URL. */
export const mediaType = (version: number) => `application/vnd.sparebank1.v${version}+json; charset=utf-8`;

export type QueryValue = string | number | boolean | readonly string[] | undefined;

export interface RequestOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Media type version, or a full Accept header. Defaults to v1. */
  accept?: number | string;
}

export class Sb1ApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`SpareBank 1 API answered ${status} for ${path}${body ? `: ${body}` : ''}`);
    this.name = 'Sb1ApiError';
  }
}

const TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY = 2_000;

export class Sb1Client {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: Sb1Auth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Calls the API and returns parsed JSON, or text for non-JSON responses such as CSV. */
  async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    let res = await this.send(path, options, await this.auth.getAccessToken());
    if (res.status === 401 && this.auth.canRefresh()) {
      await res.body?.cancel();
      res = await this.send(path, options, await this.auth.refresh());
    }
    const text = await res.text();
    if (!res.ok) throw new Sb1ApiError(res.status, path, text.slice(0, MAX_ERROR_BODY));
    if (text === '') return null;
    if ((res.headers.get('content-type') ?? '').includes('json')) return JSON.parse(text) as unknown;
    return text;
  }

  private send(path: string, options: RequestOptions, token: string): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        url.searchParams.append(name, String(value));
      } else {
        for (const item of value) url.searchParams.append(name, item);
      }
    }
    const accept = typeof options.accept === 'string' ? options.accept : mediaType(options.accept ?? 1);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: accept };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = accept;
      body = JSON.stringify(options.body);
    }
    return this.fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
}
