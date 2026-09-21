import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export const packageName = '@ivanbrykov/lead-desk';
export const checksum = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

const prereleaseIdentifier = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][\\dA-Za-z-]*)';
export const versionPattern = new RegExp(
  `^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?(?:\\+[\\dA-Za-z-]+(?:\\.[\\dA-Za-z-]+)*)?$`,
  'u',
);
export const validateManifest = (value, archive = true) => {
  assert(value?.schemaVersion === 1, 'Unsupported Lead Desk release manifest');
  assert.equal(value.packageName, packageName, 'Unexpected package name');
  assert(
    typeof value.version === 'string' && versionPattern.test(value.version),
    'Invalid package version',
  );
  assert(
    typeof value.commit === 'string' && /^[a-f0-9]{40}$/u.test(value.commit),
    'Invalid source commit',
  );
  assert.equal(value.asset, 'lead-desk.tgz', 'Unexpected release asset');
  if (archive) {
    assert(
      typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256),
      'Missing archive SHA-256',
    );
  }

  assert(
    typeof value.compatibilityDate === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/u.test(value.compatibilityDate),
    'Missing runtime compatibility date',
  );
  assert(
    Array.isArray(value.compatibilityFlags) &&
      value.compatibilityFlags.every((flag) => typeof flag === 'string'),
    'Invalid runtime flags',
  );
  assert(
    Array.isArray(value.migrations) && value.migrations.length > 0,
    'Release has no migration history',
  );
  const names = new Set();
  for (const migration of value.migrations) {
    assert(
      typeof migration.name === 'string' &&
        /^\d{4}_[\w-]+\.sql$/u.test(migration.name),
      'Unsafe migration filename',
    );
    assert(
      typeof migration.sha256 === 'string' &&
        /^[a-f0-9]{64}$/u.test(migration.sha256),
      'Invalid migration checksum',
    );
    assert(!names.has(migration.name), 'Duplicate migration filename');
    names.add(migration.name);
  }

  return value;
};

export const assertMigrationHistory = (previous, next) => {
  const current = new Map(
    next.migrations.map((migration) => [migration.name, migration.sha256]),
  );
  for (const migration of previous.migrations) {
    assert.equal(
      current.get(migration.name),
      migration.sha256,
      `Migration removed or rewritten: ${migration.name}. Updates must preserve migration history.`,
    );
  }

  const oldNames = new Set(
    previous.migrations.map((migration) => migration.name),
  );
  const last = [...oldNames].toSorted().at(-1);
  for (const migration of next.migrations) {
    assert(
      oldNames.has(migration.name) || !last || migration.name > last,
      `New migration must sort after existing history: ${migration.name}`,
    );
  }
};

export const download = async (
  url,
  {
    fetchImpl = globalThis.fetch,
    headers = {},
    limit = 32 * 1_024 * 1_024,
  } = {},
) => {
  const response = await fetchImpl(url, {
    headers,
    signal: globalThis.AbortSignal.timeout(60_000),
  });
  assert(response.ok, `Could not fetch ${url}: HTTP ${response.status}`);
  assert(
    Number(response.headers.get('content-length') ?? 0) <= limit,
    'Release download is too large',
  );
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    assert(length <= limit, 'Release download exceeded the size limit');
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
};

export const resolveRelease = async ({
  fetchImpl = globalThis.fetch,
  release = 'latest',
  repository,
  token,
}) => {
  assert(
    typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/u.test(repository),
    'Expected GitHub owner/repository',
  );
  assert(
    release === 'latest' || /^build-[a-f0-9]{40}$/u.test(release),
    'Release must be latest or an exact build-<commit> tag',
  );
  const suffix = release === 'latest' ? 'latest' : `tags/${release}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'lead-desk-installer',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const response = JSON.parse(
    (
      await download(
        `https://api.github.com/repos/${repository}/releases/${suffix}`,
        { fetchImpl, headers, limit: 1_024 * 1_024 },
      )
    ).toString('utf8'),
  );
  assert(
    response.draft === false && response.prerelease === false,
    'Release is not published',
  );
  assert(
    typeof response.tag_name === 'string' &&
      /^build-[a-f0-9]{40}$/u.test(response.tag_name),
    'Latest release is not a Lead Desk build',
  );
  if (release !== 'latest') {
    assert.equal(response.tag_name, release, 'Wrong pinned release');
  }

  assert(Array.isArray(response.assets), 'Release assets are missing');
  for (const name of ['lead-desk.tgz', 'lead-desk.json']) {
    assert(
      response.assets.some(
        (asset) => asset.name === name && asset.state === 'uploaded',
      ),
      `Release is missing ${name}`,
    );
  }

  // Resolve once. Both files come from this exact tag, even if latest moves mid-build.
  const base = `https://github.com/${repository}/releases/download/${response.tag_name}`;
  const manifest = validateManifest(
    JSON.parse(
      (
        await download(`${base}/lead-desk.json`, {
          fetchImpl,
          limit: 1_024 * 1_024,
        })
      ).toString('utf8'),
    ),
  );
  assert.equal(
    response.tag_name,
    `build-${manifest.commit}`,
    'Release tag does not match its source commit',
  );
  return { manifest, tag: response.tag_name, url: `${base}/lead-desk.tgz` };
};
