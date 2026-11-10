import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface Sb1Tokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
  obtainedAt: number;
}

/** A refresh-token grant handed to an MCP client. Keyed by the SHA-256 of the token. */
export interface McpGrant {
  clientId: string;
  scopes: string[];
  resource?: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface StoreData {
  sb1?: Sb1Tokens;
  clients: Record<string, OAuthClientInformationFull>;
  grants: Record<string, McpGrant>;
}

const empty = (): StoreData => ({ clients: {}, grants: {} });

/**
 * Everything that must survive a restart lives in one small file, encrypted
 * with AES-256-GCM. The key comes from the environment, so a leaked volume or
 * backup on its own does not expose the bank tokens.
 */
export class Store {
  private data: StoreData = empty();
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly key: Buffer,
  ) {}

  static async open(path: string, key: Buffer): Promise<Store> {
    const store = new Store(path, key);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let raw: string | undefined;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (raw !== undefined) store.data = { ...empty(), ...store.decrypt(raw) };
    return store;
  }

  get(): Readonly<StoreData> {
    return this.data;
  }

  /** Applies a change and persists it. Writes are serialized and atomic. */
  async update(change: (data: StoreData) => void): Promise<void> {
    change(this.data);
    const snapshot = this.encrypt(this.data);
    const write = this.writing.then(async () => {
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.path);
    });
    this.writing = write.catch(() => undefined);
    await write;
  }

  private encrypt(data: StoreData): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return JSON.stringify({
      v: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: body.toString('base64'),
    });
  }

  private decrypt(raw: string): StoreData {
    try {
      const file = JSON.parse(raw) as { iv: string; tag: string; data: string };
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(file.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
      const body = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]);
      return JSON.parse(body.toString('utf8')) as StoreData;
    } catch {
      throw new Error(
        `Could not decrypt ${this.path}. ENCRYPTION_KEY does not match the key the file was written with. ` +
          'Restore the original key, or delete the file and connect to SpareBank 1 again.',
      );
    }
  }
}
