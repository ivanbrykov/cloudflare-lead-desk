/**
 * Negative cache for Better Auth's database rate limiter.
 *
 * The database limiter performs a read plus an update for every request it
 * processes, including requests it rejects, so a blocked client keeps costing
 * D1 work. Once Better Auth reports a block, remember it for the retry window
 * and answer 429 without invoking the handler. Lookups check an in-isolate map
 * first, then a colo-local Cache API entry, so members of the same Cloudflare
 * location share the short-circuit.
 *
 * The database counter remains authoritative: a cache miss falls through to
 * Better Auth, and entries carry their own `expiresAt`, so cache over-retention
 * or eviction cannot extend or drop a block incorrectly. Every cache failure
 * degrades to the database limiter.
 */

const BLOCKED_UNTIL_MAP_LIMIT = 10_000;
const CACHE_NAME = 'rate-limit-blocks';
// Synthetic origin for cache keys only; nothing is served from it.
const CACHE_ORIGIN = 'https://rate-limit.invalid';
// Storage lifetime is at least a minute so short windows still land; the
// stored expiry, not the HTTP TTL, decides whether a marker counts.
const MIN_CACHE_SECONDS = 60;
const FALLBACK_RETRY_SECONDS = 10;

const blockedUntil = new Map<string, number>();
let blockCache: null | Promise<Cache> = null;

const openBlockCache = (): Promise<Cache> => {
  blockCache ??= caches.open(CACHE_NAME);
  return blockCache;
};

const prune = (now: number): void => {
  if (blockedUntil.size <= BLOCKED_UNTIL_MAP_LIMIT) {
    return;
  }

  for (const [key, expiresAt] of blockedUntil) {
    if (expiresAt <= now) {
      blockedUntil.delete(key);
    }
  }

  while (blockedUntil.size > BLOCKED_UNTIL_MAP_LIMIT) {
    const oldest = blockedUntil.keys().next().value;
    if (oldest === undefined) {
      return;
    }

    blockedUntil.delete(oldest);
  }
};

const contactKey = (request: Request, path: string): string => {
  // Mirrors Better Auth's keying: the trusted edge client address, or its
  // shared fallback for requests that never carried one.
  const clientIp = request.headers.get('cf-connecting-ip') ?? 'no-trusted-ip';
  return `${clientIp}:${path}`;
};

const secondsUntil = (expiresAt: number, now: number): number =>
  Math.max(1, Math.ceil((expiresAt - now) / 1_000));

/**
 * Returns the retry-after seconds when this client is known to be blocked,
 * or `null` when the authoritative database limiter should decide.
 */
export const blockedRetryAfter = async (
  request: Request,
  path: string,
): Promise<null | number> => {
  const now = Date.now();
  const key = contactKey(request, path);

  const memoryExpiry = blockedUntil.get(key);
  if (memoryExpiry !== undefined) {
    if (memoryExpiry > now) {
      return secondsUntil(memoryExpiry, now);
    }

    blockedUntil.delete(key);
  }

  try {
    const cache = await openBlockCache();
    const hit = await cache.match(`${CACHE_ORIGIN}/${encodeURIComponent(key)}`);
    if (hit === undefined) {
      return null;
    }

    const stored: unknown = await hit.json();
    const expiresAt = (stored as { expiresAt?: unknown }).expiresAt;
    if (typeof expiresAt !== 'number' || expiresAt <= now) {
      return null;
    }

    blockedUntil.set(key, expiresAt);
    return secondsUntil(expiresAt, now);
  } catch {
    // An unavailable cache must not weaken the database limiter.
    return null;
  }
};

/**
 * Remember a block reported by Better Auth. `retryAfterSeconds` comes from
 * Better Auth's `X-Retry-After` header when present.
 */
export const rememberBlocked = async (
  request: Request,
  path: string,
  retryAfterSeconds: number,
): Promise<void> => {
  const retryAfter =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds
      : FALLBACK_RETRY_SECONDS;
  const expiresAt = Date.now() + retryAfter * 1_000;
  const key = contactKey(request, path);
  blockedUntil.set(key, expiresAt);
  prune(Date.now());

  try {
    const cache = await openBlockCache();
    await cache.put(
      `${CACHE_ORIGIN}/${encodeURIComponent(key)}`,
      Response.json(
        { expiresAt },
        {
          headers: {
            'cache-control': `max-age=${Math.max(retryAfter, MIN_CACHE_SECONDS)}`,
            'content-type': 'application/json',
          },
        },
      ),
    );
  } catch {
    // The in-isolate marker still short-circuits this isolate.
  }
};

/**
 * The same envelope Better Auth's limiter returns.
 */
export const rateLimitedResponse = (retryAfterSeconds: number): Response =>
  Response.json(
    { message: 'Too many requests. Please try again later.' },
    {
      headers: { 'X-Retry-After': retryAfterSeconds.toString() },
      status: 429,
    },
  );
