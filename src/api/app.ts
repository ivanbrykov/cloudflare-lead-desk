import { logRequest } from './logging';
import { mapIntakeBodyError, parseIntakeBody } from '@/api/intake-parser';
import {
  createIntakeCommand,
  createLeadActivityCommand,
  createLeadCommand,
  softDeleteLeadsCommand,
  updateLeadCommand,
} from '@/application/commands';
import { type DomainError, type PersistenceError } from '@/application/errors';
import {
  type Auth,
  AuthConfigurationError,
  authenticationNotConfiguredResponse,
  createAuth,
  matchesBootstrapToken,
  resolveAuthOrigin,
} from '@/auth';
import {
  bearerToken,
  requireSessionIdentity,
  UnauthorizedError,
} from '@/auth/access';
import { handleInvitationSignUp } from '@/auth/invitation-sign-up';
import {
  blockedRetryAfter,
  rateLimitedResponse,
  rememberBlocked,
} from '@/auth/rate-limit-cache';
import { handleDisabledAccountSignIn } from '@/auth/sign-in-guard';
import {
  checkStaffInviteAvailability,
  createApiToken,
  createStaffInvite,
  type Env,
  getLead,
  isBootstrapGrantAvailable,
  isBrowserIntakeToken,
  isIntakeToken,
  listApiTokens,
  listLeadActivities,
  listLeads,
  listStaffAccounts,
  listStaffInvites,
  revokeApiToken,
  revokeStaffInvite,
  setStaffAccountDisabled,
} from '@/db/repository';
import { isIntakeKey } from '@/domain/intake';
import { decodeKeysetCursor, LIST_LIMIT_DEFAULT } from '@/domain/pagination';
import {
  BulkDeleteLeadsRequest,
  CreateInviteRequest,
  CreateLeadActivityRequest,
  CreateLeadRequest,
  CreateTokenRequest,
  HealthResponse,
  IntakeRequest,
  ListLeadsQueryRequest,
  SetStaffDisabledRequest,
  UpdateLeadRequest,
  ValidateInviteRequest,
} from '@/domain/schemas';
import { Effect, Either, Schema } from 'effect';
import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';

const errorResponse = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
) =>
  Response.json(
    { code, details, message },
    {
      status,
    },
  );

/**
 * Browser CSRF defence: a request that carries an Origin header must match the
 * configured auth origin. A missing Origin is allowed for non-browser clients,
 * consistent with the auth routes. Forwarded headers are never consulted.
 */
const rejectUntrustedOrigin = (
  environment: Env,
  request: Request,
): null | Response => {
  const origin = request.headers.get('Origin');
  if (origin === null) {
    return null;
  }

  let trusted: string;
  try {
    trusted = resolveAuthOrigin(environment, request);
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return authenticationNotConfiguredResponse();
    }

    throw error;
  }

  return origin === trusted
    ? null
    : errorResponse(403, 'forbidden', 'The request origin is not trusted.');
};

const UNSAFE_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

/**
 * Cookie-authenticated staff routes set no CORS headers, so a hostile page
 * cannot read their responses; but a same-site sibling origin can still post an
 * ordinary HTML form and have the browser attach the session cookie under
 * SameSite=Lax. Unsafe methods therefore require a trusted Origin when one is
 * present, and any supplied body must be JSON — Elysia would otherwise parse
 * form-encoded posts on these routes.
 */
const rejectUntrustedStaffWrite = (
  environment: Env,
  request: Request,
): null | Response => {
  if (!UNSAFE_METHODS.has(request.method)) {
    return null;
  }

  const rejectedOrigin = rejectUntrustedOrigin(environment, request);
  if (rejectedOrigin !== null) {
    return rejectedOrigin;
  }

  const contentType = request.headers.get('content-type');
  if (contentType !== null) {
    // The media type is everything before any parameters (`; charset=...`).
    // Only exact `application/json` is accepted: a prefix check would let
    // `application/jsonp` and similar types through.
    const mediaType = contentType.split(';')[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return errorResponse(
        415,
        'unsupported_media_type',
        'Staff requests with a body must use application/json.',
      );
    }
  }

  return null;
};

const run = async <A>(
  request: Request,
  effect: Effect.Effect<A, DomainError | PersistenceError>,
) => {
  try {
    const outcome = await Effect.runPromise(Effect.either(effect));
    if (Either.isRight(outcome)) {
      return { data: outcome.right } as const;
    }

    const error = outcome.left;
    if (error._tag === 'DomainError') {
      return {
        error: errorResponse(422, error.code, error.message, error.details),
      } as const;
    }

    // Structured failure line: the cause's class identifies the layer that
    // failed. The cause's message is deliberately not logged because a
    // database error can embed SQL with bound values (contact data).
    logRequest(request, 500, {
      errorCauseClass:
        error.cause instanceof Error
          ? error.cause.constructor.name
          : typeof error.cause,
      errorClass: 'PersistenceError',
    });
    return {
      error: errorResponse(
        500,
        'persistence_error',
        'The request could not be persisted.',
      ),
    } as const;
  } catch (error) {
    // Command defects are programmer errors; keep the class and message,
    // never the stack.
    logRequest(request, 500, {
      errorClass:
        error instanceof Error
          ? error.name || error.constructor.name
          : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return {
      error: errorResponse(
        500,
        'internal_error',
        'The request could not be completed.',
      ),
    } as const;
  }
};

const decode = <A, I>(
  schema: Schema.Schema<A, I, never>,
  value: unknown,
): Promise<A> => Schema.decodeUnknownPromise(schema)(value);

const parse = async <A, I>(
  schema: Schema.Schema<A, I, never>,
  value: unknown,
) => {
  try {
    return { data: await decode(schema, value) } as const;
  } catch (error) {
    return {
      error: errorResponse(422, 'validation_error', 'The request is invalid.', {
        issue: error instanceof Error ? error.message : String(error),
      }),
    } as const;
  }
};

type AuthForRequest = (request: Request) => Auth;

const requireAdmin = async (
  request: Request,
  getAuth: AuthForRequest,
  environment: Env,
) => {
  try {
    return {
      email: await requireSessionIdentity(
        request,
        getAuth(request),
        environment,
      ),
    } as const;
  } catch (error) {
    if (error instanceof AuthConfigurationError) {
      return { error: authenticationNotConfiguredResponse() } as const;
    }

    if (error instanceof UnauthorizedError) {
      return {
        error: errorResponse(401, 'unauthorized', error.message),
      } as const;
    }

    // The identity lookup itself failed (for example a D1 fault while
    // reading the session or staff row): this is an authentication backend
    // failure, not a lost login. Report a generic 500 so the client can
    // retry, and log the cause's class so it can be told
    // apart from a true 401 in the logs. The exception message is never
    // logged or returned because it can embed SQL with bound values.
    logRequest(request, 500, {
      errorCauseClass:
        error instanceof Error ? error.constructor.name : typeof error,
      errorClass: 'AuthenticationUnavailable',
    });
    return {
      error: errorResponse(
        500,
        'authentication_unavailable',
        'Authentication could not be checked. Please try again.',
      ),
    } as const;
  }
};

// The public intake route is unauthenticated and cookie-free, so it answers
// with `*` and no credentials. Scoped here rather than through
// @elysiajs/cors, whose onRequest hook is global and would add reflected,
// credentialed CORS headers to staff routes as well.
const PUBLIC_CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Max-Age': '86400',
} as const;

const withPublicCors = (
  response: Response | undefined,
): Response | undefined => {
  if (response === undefined) {
    return undefined;
  }

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(PUBLIC_CORS_HEADERS)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};

const createAppWithAuth = (environment: Env, getAuth: AuthForRequest) => {
  const publicIntake = new Elysia({ name: 'public-intake' })
    .options(
      '/v1/public/intakes/:token',
      () => new Response(null, { headers: PUBLIC_CORS_HEADERS, status: 204 }),
    )
    .post(
      '/v1/public/intakes/:token',
      async ({ body, params, request }) => {
        const tokenRecord = await isBrowserIntakeToken(
          environment,
          params.token,
        );
        if (!tokenRecord) {
          return withPublicCors(
            errorResponse(
              401,
              'invalid_token',
              'A valid browser intake token is required.',
            ),
          );
        }

        const clientKey =
          request.headers.get('Idempotency-Key') ?? crypto.randomUUID();
        if (!isIntakeKey(clientKey)) {
          return withPublicCors(
            errorResponse(
              400,
              'invalid_idempotency_key',
              'Idempotency-Key must be 1-128 printable ASCII characters (no spaces).',
            ),
          );
        }

        // Browser keys are namespaced per token so they can never collide with
        // keys an API integration chose for `/v1/intakes`.
        const idempotencyKey = `browser:${tokenRecord.id}:${clientKey}`;

        const parsed = await parse(IntakeRequest, body);
        if ('error' in parsed) {
          return withPublicCors(parsed.error);
        }

        const result = await run(
          request,
          createIntakeCommand(
            environment,
            parsed.data,
            idempotencyKey,
            {
              origin: request.headers.get('Origin'),
              tokenId: tokenRecord.id,
            },
            body,
          ),
        );
        if ('error' in result) {
          return withPublicCors(result.error);
        }

        switch (result.data.kind) {
          case 'conflict':
            return withPublicCors(
              errorResponse(
                409,
                'idempotency_conflict',
                'This submission was already accepted with a different payload.',
              ),
            );
          case 'created':
          case 'replayed':
            // The public surface stays minimal: no lead id is returned.
            return withPublicCors(
              Response.json({ data: { created: true } }, { status: 201 }),
            );
          case 'legacy_unverifiable':
            return withPublicCors(
              errorResponse(
                409,
                'idempotency_legacy_unverifiable',
                'This submission cannot be verified. Please use a new submission key.',
              ),
            );
        }

        return withPublicCors(
          errorResponse(
            500,
            'internal_error',
            'The intake request could not be completed.',
          ),
        );
      },
      {
        error: ({ error }) =>
          mapIntakeBodyError(error, (code, response) =>
            withPublicCors(Response.json(response, { status: code })),
          ),
        parse: parseIntakeBody,
      },
    );

  return (
    new Elysia({
      adapter: CloudflareAdapter,
      name: 'leadscroll-api',
    })
      // Elysia's mount() strips the mount prefix before forwarding. Better Auth
      // expects its full basePath, so re-add the prefix to the cloned request.
      // POST /sign-up/email is the invitation boundary: it resolves the grant
      // before any account write and re-issues the session through Better
      // Auth's sign-in endpoint.
      .mount('/api/auth', async (request: Request) => {
        try {
          const url = new URL(request.url);
          const path = url.pathname;

          // A client already over a limit skips Better Auth (and the database
          // limiter's read/update) until its retry window passes. The database
          // counter stays authoritative; this only short-circuits known blocks.
          const retryAfter = await blockedRetryAfter(request, path);
          if (retryAfter !== null) {
            return rateLimitedResponse(retryAfter);
          }

          const dispatch = async (): Promise<Response> => {
            if (request.method === 'POST' && path === '/sign-up/email') {
              return handleInvitationSignUp(environment, request, getAuth);
            }

            if (request.method === 'POST' && path === '/sign-in/email') {
              return handleDisabledAccountSignIn(environment, request, getAuth);
            }

            url.pathname = `/api/auth${path}`;
            return getAuth(request).handler(new Request(url, request));
          };

          const response = await dispatch();
          if (response.status === 429) {
            await rememberBlocked(
              request,
              path,
              Number(response.headers.get('x-retry-after') ?? ''),
            );
          }

          return response;
        } catch (error) {
          if (error instanceof AuthConfigurationError) {
            return authenticationNotConfiguredResponse();
          }

          throw error;
        }
      })
      .get('/health', () => ({ ok: true }), {
        response: { '200': Schema.standardSchemaV1(HealthResponse) },
      })
      // Contract spike: Elysia's Standard Schema path yields `code: 'VALIDATION'`
      // errors. Normalize them to the same `{ code, details, message }` envelope
      // the manual `parse()` helper returns, so clients see one error shape.
      .onError(({ code, error }) => {
        if (error instanceof Response) {
          return error;
        }

        if (code === 'VALIDATION') {
          return errorResponse(
            422,
            'validation_error',
            'The request is invalid.',
            {
              issue: error.message,
            },
          );
        }

        return undefined;
      })
      .post(
        '/v1/intakes',
        async ({ body, request }) => {
          const token = bearerToken(request);
          const tokenRecord = token
            ? await isIntakeToken(environment, token)
            : null;
          if (!tokenRecord) {
            return errorResponse(
              401,
              'unauthorized',
              'A valid intake token is required.',
            );
          }

          const idempotencyKey = request.headers.get('Idempotency-Key');
          if (!idempotencyKey) {
            return errorResponse(
              400,
              'idempotency_key_required',
              'Idempotency-Key is required.',
            );
          }

          if (!isIntakeKey(idempotencyKey)) {
            return errorResponse(
              400,
              'invalid_idempotency_key',
              'Idempotency-Key must be 1-128 printable ASCII characters (no spaces).',
            );
          }

          const parsed = await parse(IntakeRequest, body);
          if ('error' in parsed) {
            return parsed.error;
          }

          const result = await run(
            request,
            createIntakeCommand(
              environment,
              parsed.data,
              idempotencyKey,
              {
                origin: request.headers.get('Origin'),
                tokenId: tokenRecord.id,
              },
              body,
            ),
          );
          if ('error' in result) {
            return result.error;
          }

          switch (result.data.kind) {
            case 'conflict':
              return errorResponse(
                409,
                'idempotency_conflict',
                'This Idempotency-Key has already been used with a different payload. Reconcile the stored response before resubmitting.',
              );
            case 'created':
            case 'replayed':
              // Replays keep the original HTTP 201 and stored response for
              // compatibility, without touching leads or history.
              return Response.json(
                { data: result.data.response },
                { status: 201 },
              );
            case 'legacy_unverifiable': {
              const stored = result.data.storedResponse;
              return errorResponse(
                409,
                'idempotency_legacy_unverifiable',
                'This Idempotency-Key was accepted before request fingerprints existed and cannot be verified. Reconcile it against the already stored lead before submitting again.',
                typeof stored.leadId === 'string'
                  ? { leadId: stored.leadId }
                  : undefined,
              );
            }
          }

          // Every kind above returns; this guard only fires if a new outcome
          // kind is added without a handler
          return errorResponse(
            500,
            'internal_error',
            'The intake request could not be completed.',
          );
        },
        {
          error: ({ error, status }) => mapIntakeBodyError(error, status),
          // The raw intake body is bounded to 65,536 actual bytes by the
          // get-stream-backed parse hook BEFORE JSON decoding and domain
          // writes, on every accepted alias of this route. Overflow is mapped
          // to the existing 413 payload_too_large response by the error hook.
          parse: parseIntakeBody,
        },
      )
      .use(publicIntake)
      .post('/api/invites/validate', async ({ body, request }) => {
        const rejectedOrigin = rejectUntrustedOrigin(environment, request);
        if (rejectedOrigin !== null) {
          return rejectedOrigin;
        }

        const parsed = await parse(ValidateInviteRequest, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        // Non-consuming: a valid grant is reported without touching
        // used_at or any other column.
        const valid = matchesBootstrapToken(environment, parsed.data.token)
          ? await isBootstrapGrantAvailable(environment)
          : await checkStaffInviteAvailability(environment, parsed.data.token);
        return valid
          ? { valid: true }
          : errorResponse(
              403,
              'invite_unavailable',
              'Invitation is unavailable.',
            );
      })

      // Staff routes: one shared auth gate. Elysia applies lifecycle hooks to
      // routes registered after them, so every route below requires a staff
      // session; handlers read `adminEmail` from context instead of repeating
      // the guard. The gate also rejects untrusted write origins and non-JSON
      // write bodies before a handler can mutate state. Non-staff routes (auth
      // mount, health, intakes, invite validation) are registered above this
      // hook.
      .resolve(async ({ request }) => {
        const admin = await requireAdmin(request, getAuth, environment);
        if ('error' in admin) {
          throw admin.error;
        }

        const rejectedWrite = rejectUntrustedStaffWrite(environment, request);
        if (rejectedWrite !== null) {
          throw rejectedWrite;
        }

        return { adminEmail: admin.email };
      })
      .get(
        '/v1/leads',
        async ({ query }) => {
          let cursor = null;
          if (query.cursor !== undefined) {
            cursor = decodeKeysetCursor(query.cursor);
            if (cursor === null) {
              return errorResponse(
                422,
                'invalid_cursor',
                'cursor is invalid. Use the nextCursor value from a previous response.',
              );
            }
          }

          const page = await listLeads(environment, {
            cursor,
            limit: query.limit ?? LIST_LIMIT_DEFAULT,
            query: query.query,
          });
          return { data: page.leads, nextCursor: page.nextCursor };
        },
        { query: Schema.standardSchemaV1(ListLeadsQueryRequest) },
      )
      .post(
        '/v1/leads',
        async ({ body, request }) => {
          const result = await run(
            request,
            createLeadCommand(environment, body),
          );
          return 'error' in result
            ? result.error
            : Response.json({ data: result.data }, { status: 201 });
        },
        { body: Schema.standardSchemaV1(CreateLeadRequest) },
      )
      .post(
        '/v1/leads/bulk-delete',
        async ({ body, request }) => {
          const result = await run(
            request,
            softDeleteLeadsCommand(environment, body.ids),
          );
          return 'error' in result
            ? result.error
            : { data: { deleted: result.data } };
        },
        { body: Schema.standardSchemaV1(BulkDeleteLeadsRequest) },
      )
      .patch(
        '/v1/leads/:id',
        async ({ body, params, request }) => {
          const result = await run(
            request,
            updateLeadCommand(environment, params.id, body),
          );
          if ('error' in result) {
            return result.error;
          }

          return result.data
            ? { data: result.data }
            : errorResponse(404, 'not_found', 'Lead not found.');
        },
        { body: Schema.standardSchemaV1(UpdateLeadRequest) },
      )
      .get('/v1/leads/:id/activities', async ({ params }) => {
        return { data: await listLeadActivities(environment, params.id) };
      })
      .post(
        '/v1/leads/:id/activities',
        async ({ adminEmail, body, params, request }) => {
          const result = await run(
            request,
            createLeadActivityCommand(
              environment,
              params.id,
              adminEmail,
              body.kind ?? 'note',
              body.body,
            ),
          );
          if ('error' in result) {
            return result.error;
          }

          return result.data
            ? Response.json({ data: result.data }, { status: 201 })
            : errorResponse(404, 'not_found', 'Lead not found.');
        },
        { body: Schema.standardSchemaV1(CreateLeadActivityRequest) },
      )
      .get('/v1/leads/:id', async ({ params }) => {
        const lead = await getLead(environment, params.id);
        return lead
          ? { data: lead }
          : errorResponse(404, 'not_found', 'Lead not found.');
      })
      .get('/v1/tokens', async () => {
        return { data: await listApiTokens(environment) };
      })
      .post('/v1/tokens', async ({ body }) => {
        const parsed = await parse(CreateTokenRequest, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        return Response.json(
          {
            data: await createApiToken(environment, {
              expiresAt: parsed.data.expiresAt,
              name: parsed.data.name,
              type: parsed.data.type ?? 'api',
            }),
          },
          { status: 201 },
        );
      })
      .delete('/v1/tokens/:id', async ({ params }) => {
        return (await revokeApiToken(environment, params.id))
          ? new Response(null, { status: 204 })
          : errorResponse(404, 'not_found', 'Token not found.');
      })
      .get('/v1/invites', async () => {
        return { data: await listStaffInvites(environment) };
      })
      .post('/v1/invites', async ({ body }) => {
        const parsed = await parse(CreateInviteRequest, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const invite = await createStaffInvite(
          environment,
          parsed.data.name,
          parsed.data.expiresAt,
        );
        return Response.json(
          {
            data: {
              createdAt: invite.createdAt,
              expiresAt: invite.expiresAt,
              id: invite.id,
              name: invite.name,
              prefix: invite.prefix,
              // The raw token is returned exactly once, at creation.
              token: invite.token,
            },
          },
          { status: 201 },
        );
      })
      .delete('/v1/invites/:id', async ({ params }) => {
        return (await revokeStaffInvite(environment, params.id))
          ? new Response(null, { status: 204 })
          : errorResponse(404, 'not_found', 'Invitation not found.');
      })
      .get('/v1/staff', async () => {
        return { data: await listStaffAccounts(environment) };
      })
      .patch('/v1/staff/:id', async ({ adminEmail, body, params }) => {
        const parsed = await parse(SetStaffDisabledRequest, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const outcome = await setStaffAccountDisabled(
          environment,
          params.id,
          parsed.data.disabled,
          adminEmail,
        );
        if (outcome.kind === 'not-found') {
          return errorResponse(404, 'not_found', 'Staff account not found.');
        }

        if (outcome.kind === 'self') {
          return errorResponse(
            409,
            'conflict',
            'An account cannot disable itself.',
          );
        }

        if (outcome.kind === 'last-enabled') {
          return errorResponse(
            409,
            'conflict',
            'The last enabled staff account cannot be disabled.',
          );
        }

        return { data: outcome.record };
      })
  );
};

export const createApp = (environment: Env) =>
  createAppWithAuth(environment, (request) => createAuth(environment, request));
