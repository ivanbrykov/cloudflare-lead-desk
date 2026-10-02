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

const openBlockCacheOnce = async (): Promise<Cache> => {
  try {
    return await caches.open(CACHE_NAME);
  } catch (error) {
    // A failed open must not poison every later request in this isolate.
    blockCache = null;
    throw error;
  }
};

const openBlockCache = (): Promise<Cache> => {
  blockCache ??= openBlockCacheOnce();
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

/**
 * The first 64 bits of an IPv6 address as a stable group key.
 */
const ipv6Subnet = (address: string): string => {
  const [head = '', tail = ''] = address.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const zeros = Array.from(
    { length: Math.max(0, 8 - headGroups.length - tailGroups.length) },
    () => '0',
  );
  return [...headGroups, ...zeros, ...tailGroups].slice(0, 4).join(':');
};

const normalizeClientIp = (address: string): string => {
  const value = address.split('%')[0]?.toLowerCase() ?? address;
  return value.includes(':') ? ipv6Subnet(value) : value;
};

const contactKey = (request: Request, path: string): string => {
  // Mirrors Better Auth's keying: the trusted edge client address, or its
  // shared fallback for requests that never carried one. IPv6 clients are
  // grouped by /64, matching Better Auth's default `ipv6Subnet`, so another
  // address in a blocked subnet still hits this marker.
  const header = request.headers.get('cf-connecting-ip');
  const clientIp =
    header === null ? 'no-trusted-ip' : normalizeClientIp(header);
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
