import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const API_BASE = 'https://api.figma.com';

export class FigmaApiError extends Error {
  status: number;
  body: unknown;
  retryAfter?: number;
  constructor(status: number, body: unknown, message?: string, retryAfter?: number) {
    super(message || `Figma API error ${status}: ${safeBodyPreview(body)}`);
    this.name = 'FigmaApiError';
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

function safeBodyPreview(body: unknown): string {
  try {
    const s = typeof body === 'string' ? body : JSON.stringify(body);
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  } catch {
    return String(body);
  }
}

export interface RateLimitInfo {
  lastStatus?: number;
  lastRetryAfter?: number;
  /** Any x-* / retry-after headers observed on the most recent response. */
  lastHeaders?: Record<string, string>;
  total429: number;
  totalRequests: number;
  cacheHits: number;
}

export interface RestClientOptions {
  token?: string;
  cacheRoot: string;
  cacheEnabled?: boolean;
  /** TTL for document endpoints (files/nodes/styles). */
  docTtlMs: number;
  /** TTL for rendered image maps + downloaded binaries. */
  renderTtlMs: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Max retry attempts for 429 / 5xx / network errors. Default 3. */
  maxRetries?: number;
}

interface CacheEntry {
  fetchedAt: number;
  ttl: number;
  status: number;
  body: unknown;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function hashKey(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex');
}

/**
 * Figma REST client: PAT auth, per-minute rate-limit backoff, disk cache.
 * Facts (see ARCHITECTURE.md):
 *  - Auth header: X-Figma-Token. Free plan OK; limits are per-minute only.
 *  - Temp URLs from /v1/images expire (~30 days) — download immediately and cache.
 */
export class FigmaRestClient {
  readonly token?: string;
  private cacheRoot: string;
  private cacheEnabled: boolean;
  private docTtlMs: number;
  private renderTtlMs: number;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private maxRetries: number;
  readonly rateLimit: RateLimitInfo = { total429: 0, totalRequests: 0, cacheHits: 0 };

  constructor(opts: RestClientOptions) {
    this.token = opts.token;
    this.cacheRoot = opts.cacheRoot;
    this.cacheEnabled = opts.cacheEnabled !== false;
    this.docTtlMs = opts.docTtlMs;
    this.renderTtlMs = opts.renderTtlMs;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  requireToken(): string {
    if (!this.token) {
      throw new Error(
        'No Figma token configured. Set FIGMA_API_KEY (or FIGMA_TOKEN), or pass --token. ' +
          'Create a Personal Access Token at https://www.figma.com/developers/api#access-tokens',
      );
    }
    return this.token;
  }

  private cachePath(scope: string, key: string): string {
    return path.join(this.cacheRoot, scope, `${hashKey(key)}.json`);
  }

  private readCache(scope: string, key: string): CacheEntry | undefined {
    if (!this.cacheEnabled) return undefined;
    const p = this.cachePath(scope, key);
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const entry = JSON.parse(raw) as CacheEntry;
      if (Date.now() - entry.fetchedAt > entry.ttl) return undefined;
      return entry;
    } catch {
      return undefined;
    }
  }

  private writeCache(scope: string, key: string, entry: CacheEntry): void {
    if (!this.cacheEnabled) return;
    const p = this.cachePath(scope, key);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify(entry));
    } catch {
      /* cache write failures are non-fatal */
    }
  }

  private recordHeaders(res: Response, status: number, retryAfter?: number) {
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (k.startsWith('x-') || k === 'retry-after') headers[k] = v;
    });
    this.rateLimit.lastStatus = status;
    this.rateLimit.lastHeaders = headers;
    if (retryAfter !== undefined) this.rateLimit.lastRetryAfter = retryAfter;
  }

  /** Raw GET with retry/backoff. Returns parsed JSON body. */
  async getJson<T = unknown>(
    apiPath: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; ttlMs?: number; scope?: string; noCache?: boolean } = {},
  ): Promise<{ body: T; fromCache: boolean }> {
    const token = this.requireToken();
    const qs = Object.entries(opts.query ?? {})
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const url = `${API_BASE}${apiPath}${qs ? `?${qs}` : ''}`;
    const scope = opts.scope ?? this.scopeFromPath(apiPath);
    const cacheKey = url;
    if (!opts.noCache) {
      const hit = this.readCache(scope, cacheKey);
      if (hit) {
        this.rateLimit.cacheHits++;
        return { body: hit.body as T, fromCache: true };
      }
    }

    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= this.maxRetries) {
      this.rateLimit.totalRequests++;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers: { 'X-Figma-Token': token } });
      } catch (err) {
        lastErr = err;
        attempt++;
        if (attempt > this.maxRetries) break;
        await this.sleep(Math.min(1000 * 2 ** attempt, 15000));
        continue;
      }
      const status = res.status;
      if (status === 429) {
        this.rateLimit.total429++;
        const ra = Number(res.headers.get('retry-after') ?? '0');
        this.recordHeaders(res, status, ra);
        attempt++;
        if (attempt > this.maxRetries) {
          throw new FigmaApiError(429, undefined, 'Figma rate limit exceeded (429) — retries exhausted', ra);
        }
        await this.sleep(Math.min((ra > 0 ? ra : 5) * 1000, 60000));
        continue;
      }
      if (status >= 500 && attempt < this.maxRetries) {
        attempt++;
        this.recordHeaders(res, status);
        await this.sleep(Math.min(1000 * 2 ** attempt, 15000));
        continue;
      }
      const text = await res.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = text;
      }
      this.recordHeaders(res, status);
      if (!res.ok) {
        throw new FigmaApiError(status, body);
      }
      const ttl = opts.ttlMs ?? this.docTtlMs;
      if (!opts.noCache) {
        this.writeCache(scope, cacheKey, { fetchedAt: Date.now(), ttl, status, body });
      }
      return { body: body as T, fromCache: false };
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private scopeFromPath(apiPath: string): string {
    const m = apiPath.match(/^\/v1\/(?:files|images)\/([\w-]+)/);
    return m ? m[1] : 'misc';
  }

  /** Download arbitrary bytes (temp render URLs need no auth; api.figma.com gets the token). */
  async downloadBinary(url: string, ttlMs?: number): Promise<Buffer> {
    const scope = 'bin';
    const cached = this.readCache(scope, url);
    if (cached && typeof (cached.body as { b64?: string }).b64 === 'string') {
      this.rateLimit.cacheHits++;
      return Buffer.from((cached.body as { b64: string }).b64, 'base64');
    }
    const headers: Record<string, string> = {};
    if (url.startsWith(API_BASE)) headers['X-Figma-Token'] = this.requireToken();
    const res = await this.fetchImpl(url, { headers });
    if (!res.ok) throw new FigmaApiError(res.status, await res.text().catch(() => undefined), `Download failed ${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    this.writeCache(scope, url, { fetchedAt: Date.now(), ttl: ttlMs ?? this.renderTtlMs, status: 200, body: { b64: buf.toString('base64') } });
    return buf;
  }

  // ---- Typed endpoint helpers (paths per ARCHITECTURE.md "Figma REST API facts") ----

  async getMe<T = unknown>(): Promise<T> {
    return (await this.getJson<T>('/v1/me', { noCache: true })).body;
  }

  async getFile<T = unknown>(fileKey: string, opts: { depth?: number; geometry?: boolean } = {}): Promise<T> {
    return (
      await this.getJson<T>(`/v1/files/${fileKey}`, {
        query: { depth: opts.depth, geometry: opts.geometry ? 'bounds' : undefined },
        ttlMs: this.docTtlMs,
      })
    ).body;
  }

  async getNodes<T = unknown>(fileKey: string, ids: string[], opts: { depth?: number; geometry?: boolean } = {}): Promise<T> {
    return (
      await this.getJson<T>(`/v1/files/${fileKey}/nodes`, {
        query: { ids: ids.join(','), depth: opts.depth, geometry: opts.geometry ? 'bounds' : undefined },
        ttlMs: this.docTtlMs,
      })
    ).body;
  }

  async getImages<T = unknown>(
    fileKey: string,
    ids: string[],
    opts: { format?: 'png' | 'jpg' | 'svg' | 'pdf'; scale?: number } = {},
  ): Promise<T> {
    return (
      await this.getJson<T>(`/v1/images/${fileKey}`, {
        query: { ids: ids.join(','), format: opts.format ?? 'png', scale: opts.scale ?? 2 },
        ttlMs: this.renderTtlMs,
      })
    ).body;
  }

  async getImageFills<T = unknown>(fileKey: string): Promise<T> {
    return (await this.getJson<T>(`/v1/files/${fileKey}/images`, { ttlMs: this.renderTtlMs })).body;
  }

  async getStyles<T = unknown>(fileKey: string): Promise<T> {
    return (await this.getJson<T>(`/v1/files/${fileKey}/styles`, { ttlMs: this.docTtlMs })).body;
  }

  /** Enterprise-only endpoint; callers should handle 403 fallback. */
  async getLocalVariables<T = unknown>(fileKey: string): Promise<T> {
    return (await this.getJson<T>(`/v1/files/${fileKey}/variables/local`, { ttlMs: this.docTtlMs, noCache: true })).body;
  }

  cacheStats(): { root: string; files: number; bytes: number } {
    let files = 0;
    let bytes = 0;
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else {
          files++;
          try {
            bytes += fs.statSync(p).size;
          } catch {
            /* ignore */
          }
        }
      }
    };
    walk(this.cacheRoot);
    return { root: this.cacheRoot, files, bytes };
  }

  clearCache(): { removed: number } {
    const stats = this.cacheStats();
    try {
      fs.rmSync(this.cacheRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return { removed: stats.files };
  }
}
