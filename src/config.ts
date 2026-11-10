import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Reads NAME, or the contents of the file named by NAME_FILE (Docker/Dokploy
 * secrets), so secrets never have to sit in the process environment.
 */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) return readFileSync(file, 'utf8').trim();
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function parseKey(value: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes, hex or base64 encoded (generate with: openssl rand -base64 32)');
  }
  return key;
}

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  SB1_CLIENT_ID: z.string().min(1),
  SB1_CLIENT_SECRET: z.string().min(1),
  SB1_FIN_INST: z
    .string()
    .regex(/^fid-[a-z0-9-]+$/, 'expected a value like fid-smn')
    .optional(),
  SB1_API_BASE_URL: z.url().default('https://api.sparebank1.no'),
  SB1_ENABLE_TRANSFERS: bool,
  PUBLIC_URL: z.url(),
  ADMIN_PASSWORD: z.string().min(16, 'use at least 16 characters'),
  ENCRYPTION_KEY: z.string().min(1),
  MCP_STATIC_TOKEN: z.string().min(32, 'use at least 32 characters').optional(),
  DATA_DIR: z.string().default('./data'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(1),
});

export interface Config {
  sb1: {
    clientId: string;
    clientSecret: string;
    finInst?: string;
    apiBaseUrl: string;
    enableTransfers: boolean;
    redirectUri: string;
  };
  /** Externally visible origin of this server, without a trailing slash. */
  publicUrl: string;
  /** The URL MCP clients connect to. */
  mcpUrl: string;
  adminPassword: string;
  encryptionKey: Buffer;
  staticToken?: string;
  dataDir: string;
  port: number;
  host: string;
  trustProxy: number;
}

const NAMES = Object.keys(schema.shape);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const raw: Record<string, string | undefined> = {};
  for (const name of NAMES) raw[name] = readEnv(env, name);

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const c = parsed.data;

  const publicUrl = new URL(c.PUBLIC_URL);
  const local = publicUrl.hostname === 'localhost' || publicUrl.hostname === '127.0.0.1';
  if (publicUrl.protocol !== 'https:' && !local) {
    throw new Error('Invalid configuration:\n  PUBLIC_URL: must use https (http is only allowed for localhost)');
  }
  const origin = publicUrl.origin;

  return {
    sb1: {
      clientId: c.SB1_CLIENT_ID,
      clientSecret: c.SB1_CLIENT_SECRET,
      finInst: c.SB1_FIN_INST,
      apiBaseUrl: c.SB1_API_BASE_URL.replace(/\/+$/, ''),
      enableTransfers: c.SB1_ENABLE_TRANSFERS,
      redirectUri: `${origin}/sparebank1/callback`,
    },
    publicUrl: origin,
    mcpUrl: `${origin}/mcp`,
    adminPassword: c.ADMIN_PASSWORD,
    encryptionKey: parseKey(c.ENCRYPTION_KEY),
    staticToken: c.MCP_STATIC_TOKEN,
    dataDir: c.DATA_DIR,
    port: c.PORT,
    host: c.HOST,
    trustProxy: c.TRUST_PROXY,
  };
}
