import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export const createReleaseClient = ({
  fetchImpl = globalThis.fetch,
  repository,
  token,
}) => {
  assert(/^[\w.-]+\/[\w.-]+$/u.test(repository), 'Expected owner/repository');
  assert(token, 'Missing release token');
  const request = async (
    host,
    path,
    { binary = false, body, method = 'GET' } = {},
  ) => {
    const response = await fetchImpl(
      `https://${host}/repos/${repository}/${path}`,
      {
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Cache-Control': 'no-cache',
          ...(body === undefined
            ? {}
            : {
                'Content-Type': binary
                  ? 'application/octet-stream'
                  : 'application/json',
              }),
        },
        method,
        redirect: 'error',
        signal: globalThis.AbortSignal.timeout(binary ? 120_000 : 30_000),
        ...(body === undefined
          ? {}
          : { body: binary ? body : JSON.stringify(body) }),
      },
    );
    if (method === 'GET' && response.status === 404) {
      return null;
    }

    assert(
      response.ok,
      `GitHub ${method} ${path} failed: HTTP ${response.status}`,
    );
    return response.status === 204 ? null : response.json();
  };

  const api = (path, options) => request('api.github.com', path, options);
  const findRelease = async (tag) => {
    const published = await api(`releases/tags/${tag}`);
    if (published) {
      return published;
    }

    for (let page = 1; ; page += 1) {
      const releases = await api(`releases?per_page=100&page=${page}`);
      assert(
        Array.isArray(releases),
        'Could not list releases to locate an existing draft',
      );
      const found = releases.find((release) => release.tag_name === tag);
      if (found) {
        return found;
      }

      if (releases.length < 100) {
        return null;
      }
    }
  };

  const readDraft = async (id, tag) => {
    assert(Number.isSafeInteger(id) && id > 0, 'Invalid draft release ID');
    // Only GET visibility is retried, using the known ID. Writes are never retried.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const release = await api(`releases/${id}`);
      if (release === null && attempt < 2) {
        await delay(500 * (attempt + 1));
        continue;
      }

      assert(
        release?.id === id &&
          release.draft === true &&
          release.tag_name === tag,
        `Release changed state during publishing; expected draft ${id} (${tag}).`,
      );
      return release;
    }

    throw new Error(`Draft ${id} remained unavailable after bounded reads`);
  };

  const createDraft = async ({ body, commit, name, tag }) => {
    const created = await api('releases', {
      body: {
        body,
        draft: true,
        name,
        prerelease: false,
        tag_name: tag,
        target_commitish: commit,
      },
      method: 'POST',
    });
    assert(
      Number.isSafeInteger(created?.id) &&
        created.id > 0 &&
        created.draft === true &&
        created.tag_name === tag,
      'GitHub creation response did not identify the requested draft',
    );
    // The creation response is authoritative. Never search a listing for this new draft.
    return created;
  };

  const uploadAsset = (id, name, bytes) =>
    request(
      'uploads.github.com',
      `releases/${id}/assets?name=${encodeURIComponent(name)}`,
      { binary: true, body: bytes, method: 'POST' },
    );
  return { api, createDraft, findRelease, readDraft, uploadAsset };
};
