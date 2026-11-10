import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** Constant-time string comparison. Hashing first hides the length of the secret as well. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/**
 * Brute-force protection for the admin password. The limit is global rather than
 * per IP address: there is one legitimate user, and client addresses behind a
 * proxy can be forged.
 */
export class AttemptLimiter {
  private failures: number[] = [];

  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60_000,
  ) {}

  blocked(now = Date.now()): boolean {
    this.failures = this.failures.filter((t) => now - t < this.windowMs);
    return this.failures.length >= this.max;
  }

  recordFailure(now = Date.now()): void {
    this.failures.push(now);
  }
}

/** A small in-memory map whose entries expire and can be taken exactly once. */
export class ExpiringMap<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1000,
  ) {}

  set(key: string, value: T): void {
    this.sweep();
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  take(key: string): T | undefined {
    const value = this.get(key);
    this.entries.delete(key);
    return value;
  }

  clear(): void {
    this.entries.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }
}
