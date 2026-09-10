import { Effect, Either, Schema } from 'effect';
import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';
import { openApiSpecification } from './openapi';
import {
  createActivityCommand,
  createContactCommand,
  createManualOpportunityCommand,
  deleteContactCommand,
  createCustomFieldCommand,
  createIntakeCommand,
  createPipelineCommand,
  createStageCommand,
  moveOpportunityCommand,
  updateContactCommand,
} from '@/application/commands';
import { DomainError, PersistenceError } from '@/application/errors';
import { UnauthorizedError, bearerToken, requireAccessIdentity } from '@/auth/access';
import {
  archiveFieldDefinition,
  createApiToken,
  getContact,
  getFieldDefinitions,
  getOpportunity,
  getPipeline,
  isIntakeToken,
  listActivities,
  listApiTokens,
  listContacts,
  listOpportunities,
  listPipelines,
  revokeApiToken,
  type Env,
} from '@/db/repository';
import {
  ContactInputSchema,
  CreateActivitySchema,
  CreateCustomFieldSchema,
  CreateOpportunitySchema,
  CreatePipelineSchema,
  CreateStageSchema,
  CreateTokenSchema,
  IntakeInputSchema,
  MoveOpportunitySchema,
} from '@/domain/schemas';
import { isIntakeKey } from '@/domain/intake';
import { CONTACT_LIMIT_DEFAULT, decodeContactCursor, parseContactLimit } from '@/domain/pagination';
import { mapIntakeBodyError, parseIntakeBody } from '@/api/intake-parser';

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

const run = async <A>(effect: Effect.Effect<A, DomainError | PersistenceError>) => {
  try {
    const outcome = await Effect.runPromise(Effect.either(effect));
    if (Either.isRight(outcome)) return { data: outcome.right } as const;
    const error = outcome.left;
    if (error._tag === 'DomainError') {
      return { error: errorResponse(422, error.code, error.message, error.details) } as const;
    }
    console.error('Lead Desk persistence failed', error.cause);
    return { error: errorResponse(500, 'persistence_error', 'The request could not be persisted.') } as const;
  } catch (error) {
    console.error('Lead Desk command defect', error);
    return { error: errorResponse(500, 'internal_error', 'The request could not be completed.') } as const;
  }
};

const decode = <A, I>(schema: Schema.Schema<A, I, never>, value: unknown): Promise<A> =>
  Schema.decodeUnknownPromise(schema)(value);

const parse = async <A, I>(schema: Schema.Schema<A, I, never>, value: unknown) => {
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

const requireAdmin = async (request: Request, env: Env) => {
  try {
    return { email: await requireAccessIdentity(request, env) } as const;
  } catch (error) {
    return {
      error: errorResponse(
        401,
        'unauthorized',
        error instanceof UnauthorizedError ? error.message : 'Authentication is required.',
      ),
    } as const;
  }
};

export const createApp = (env: Env) =>
  new Elysia({ adapter: CloudflareAdapter, name: 'cloudflare-lead-desk-api' })
    .get('/health', () => ({ ok: true }))
    .get('/openapi', () => Response.json(openApiSpecification))
    .get('/v1/contacts', async ({ request, query }) => {
      const admin = await requireAdmin(request, env);
      if ('error' in admin) return admin.error;
      const limit =
        query.limit === undefined
          ? CONTACT_LIMIT_DEFAULT
          : parseContactLimit(query.limit);
      if (limit === null) {
        return errorResponse(
          422,
          'validation_error',
          'limit must be an integer between 1 and 100.',
        );
      }
      let cursor = null;
      if (query.cursor !== undefined) {
        cursor = decodeContactCursor(query.cursor);
        if (cursor === null) {
          return errorResponse(
            422,
            'invalid_cursor',
            'cursor is invalid. Use the nextCursor value from a previous response.',
          );
        }
      }
      const page = await listContacts(env, {
        cursor,
        limit,
        query: query.query ?? undefined,
      });
      return {
        // Items keep the flat contact shape (top-level fields, customFields)
        // for the staff UI, and each also exposes the record under `data`
        // for envelope-style consumers.
        data: page.contacts.map((contact) => ({ ...contact, data: contact })),
        nextCursor: page.nextCursor,
      };
    })
    .post(
      '/v1/contacts',
      async ({ body, request }) => {
        const admin = await requireAdmin(request, env);
        if ('error' in admin) return admin.error;
        const parsed = await parse(ContactInputSchema, body);
        if ('error' in parsed) return parsed.error;
        const result = await run(createContactCommand(env, parsed.data));
        return 'error' in result ? result.error : Response.json({ data: result.data }, { status: 201 });
      }
    )
    .get('/v1/contacts/:id', async ({ params, request }) => {
      const admin = await requireAdmin(request, env);
      if ('error' in admin) return admin.error;
      const contact = await getContact(env, params.id);
      return contact
        ? { data: contact }
        : errorResponse(404, 'not_found', 'Contact not found.');
    })
    .put(
      '/v1/contacts/:id',
      async ({ body, params, request }) => {
        const admin = await requireAdmin(request, env);
        if ('error' in admin) return admin.error;
        const parsed = await parse(ContactInputSchema, body);
        if ('error' in parsed) return parsed.error;
        const result = await run(updateContactCommand(env, params.id, parsed.data));
        if ('error' in result) return result.error;
        return result.data
          ? { data: result.data }
          : errorResponse(404, 'not_found', 'Contact not found.');
      },
    )
    .delete('/v1/contacts/:id', async ({ params, request }) => {
      const admin = await requireAdmin(request, env);
      if ('error' in admin) return admin.error;
      const result = await run(deleteContactCommand(env, params.id));
      if ('error' in result) return result.error;
      if (result.data === 'deleted') return new Response(null, { status: 204 });
      if (result.data === 'has_opportunities') {
        return errorResponse(409, 'contact_has_opportunities', 'Contacts with opportunities cannot be deleted.');
      }
      return errorResponse(404, 'not_found', 'Contact not found.');
    })
    .post(
      '/v1/opportunities',
      async ({ body, request }) => {
        const admin = await requireAdmin(request, env);
        if ('error' in admin) return admin.error;
        const parsed = await parse(CreateOpportunitySchema, body);
        if ('error' in parsed) return parsed.error;
        const result = await run(createManualOpportunityCommand(env, parsed.data, admin.email));
        if ('error' in result) return result.error;
        if (result.data === 'contact_not_found') {
          return errorResponse(404, 'not_found', 'Contact not found.');
        }
        if (result.data === 'invalid_stage') {
          return errorResponse(422, 'invalid_stage', 'The selected stage does not belong to this pipeline.');
        }
        return Response.json({ data: result.data }, { status: 201 });
      },
    )
    .get('/v1/opportunities', async ({ request, query }) => {
      const admin = await requireAdmin(request, env);
      if ('error' in admin) return admin.error;
      const pipelineId = query.pipelineId;
      if (pipelineId !== undefined) {
        // The filter only accepts pipelines of the current workspace that
        // are not archived; anything else is rejected before listing.
        const pipeline = typeof pipelineId === 'string' ? await getPipeline(env, pipelineId) : null;
        if (!pipeline || pipeline.archivedAt !== null) {
          return errorResponse(
            422,
            'validation_error',
            'pipelineId must reference an active pipeline of the current workspace.',
          );
        }
      }
      return { data: await listOpportunities(env, pipelineId) };
    })
    .get('/v1/opportunities/:id', async ({ params, request }) => {
      const admin = await requireAdmin(request, env);
      if ('error' in admin) return admin.error;
      const opportunity = await getOpportunity(env, params.id);
      return opportunity
        ? { data: opportunity }
        : errorResponse(404, 'not_found', 'Opportunity not found.');
    })
    .post(
      '/v1/opportunities/:id/move',
      async ({ body, params, request }) => {
        const admin = await requireAdmin(request, env);
        if ('error' in admin) return admin.error;
        const parsed = await parse(MoveOpportunitySchema, body);
        if ('error' in parsed) return parsed.error;
        const result = await run(
          moveOpportunityCommand(env, params.id, parsed.data.stageId, admin.email),
        );
        if ('error' in result) return result.error;
        return result.data
          ? { data: result.data }
          : errorResponse(404, 'not_found', 'Opportunity not found.');
      }
    )
    .get('/v1/opportunities/:id/activities', async ({ params, request }) => {
      const admin = await requireAdmin(request, env);
      if ('error' in admin) return admin.error;
      return { data: await listActivities(env, params.id) };
    })
    .post(
      '/v1/opportunities/:id/activities',
      async ({ body, params, request }) => {
        const admin = await requireAdmin(request, env);
        if ('error' in admin) return admin.error;
        const parsed = await parse(CreateActivitySchema, body);
        if ('error' in parsed) return parsed.error;
        const result = await run(
          createActivityCommand(
            env,
            params.id,
            admin.email,
            parsed.data.kind ?? 'note',
            parsed.data.body,
          ),
        );
        if ('error' in result) return result.error;
        return result.data
          ? Response.json({ data: result.data }, { status: 201 })
          : errorResponse(404, 'not_found', 'Opportunity not found.');
      }
    )
    .get('/v1/pipelines', async ({ request }) => {
      const admin = await requireAdmin(request, env);
      if ('error' in admin) return admin.error;
      return { data: await listPipelines(env) };
    })
    .post(
      '/v1/pipelines',
      async ({ body, request }) => {
        const admin = await requireAdmin(request, env);
        if ('error' in admin) return admin.error;
        const parsed = await parse(CreatePipelineSchema, body);
        if ('error' in parsed) return parsed.error;
        const result = await run(createPipelineCommand(env, parsed.data.name));
        return 'error' in result ? result.error : Response.json({ data: result.data }, { status: 201 });
      }
    )
    .post(
      '/v1/pipelines/:id/stages',
      async ({ body, params, request }) => {
        const admin = await requireAdmin(request, env);
        if ('error' in admin) return admin.error;
        const parsed = await parse(CreateStageSchema, body);
        if ('error' in parsed) return parsed.error;
        const result = await run(createStageCommand(env, params.id, parsed.data));
        return 'error' in result ? result.error : Response.json({ data: result.data }, { status: 201 });
      }
    )
    .get('/v1/custom-fields', async ({ query, request }) => {
      const admin = await requireAdmin(request, env);
      if ('error' in admin) return admin.error;
      if (query.entityType !== 'contact' && query.entityType !== 'opportunity') {
        return errorResponse(422, 'validation_error', 'entityType is required.');
      }
      return { data: await getFieldDefinitions(env, query.entityType) };
    })
    .post(
      '/v1/custom-fields',
      async ({ body, request }) => {
        const admin = await requireAdmin(request, env);
        if ('error' in admin) return admin.error;
        const parsed = await parse(CreateCustomFieldSchema, body);
        if ('error' in parsed) return parsed.error;
        if (parsed.data.type === 'select' && (!parsed.data.options || parsed.data.options.length === 0)) {
          return errorResponse(422, 'validation_error', 'Select fields need at least one option.');
        }
        const result = await run(createCustomFieldCommand(env, parsed.data));
        return 'error' in result ? result.error : Response.json({ data: result.data }, { status: 201 });
      }
    )
    .delete('/v1/custom-fields/:id', async ({ params, request }) => {
      const admin = await requireAdmin(request, env);
      if ('error' in admin) return admin.error;
      return (await archiveFieldDefinition(env, params.id))
        ? new Response(null, { status: 204 })
        : errorResponse(404, 'not_found', 'Custom field not found.');
    })
    .get('/v1/tokens', async ({ request }) => {
      const admin = await requireAdmin(request, env);
      if ('error' in admin) return admin.error;
      return { data: await listApiTokens(env) };
    })
    .post(
      '/v1/tokens',
      async ({ body, request }) => {
        const admin = await requireAdmin(request, env);
        if ('error' in admin) return admin.error;
        const parsed = await parse(CreateTokenSchema, body);
        if ('error' in parsed) return parsed.error;
        return Response.json({ data: await createApiToken(env, parsed.data.name) }, { status: 201 });
      }
    )
    .delete('/v1/tokens/:id', async ({ params, request }) => {
      const admin = await requireAdmin(request, env);
      if ('error' in admin) return admin.error;
      return (await revokeApiToken(env, params.id))
        ? new Response(null, { status: 204 })
        : errorResponse(404, 'not_found', 'Token not found.');
    })
    .post(
      '/v1/intakes',
      async ({ body, request }) => {
        const token = bearerToken(request);
        if (!token || !(await isIntakeToken(env, token))) {
          return errorResponse(401, 'unauthorized', 'A valid intake token is required.');
        }
        const idempotencyKey = request.headers.get('Idempotency-Key');
        if (!idempotencyKey) {
          return errorResponse(400, 'idempotency_key_required', 'Idempotency-Key is required.');
        }
        if (!isIntakeKey(idempotencyKey)) {
          return errorResponse(
            400,
            'invalid_idempotency_key',
            'Idempotency-Key must be 1-128 printable ASCII characters (no spaces).',
          );
        }
        const parsed = await parse(IntakeInputSchema, body);
        if ('error' in parsed) return parsed.error;
        const result = await run(createIntakeCommand(env, parsed.data, idempotencyKey));
        if ('error' in result) return result.error;
        switch (result.data.kind) {
          case 'created':
          case 'replayed':
            // Replays keep the original HTTP 201 and stored response for
            // compatibility, without touching contacts or history.
            return Response.json({ data: result.data.response }, { status: 201 });
          case 'conflict':
            return errorResponse(
              409,
              'idempotency_conflict',
              'This Idempotency-Key has already been used with a different payload. Reconcile the stored response before resubmitting.',
            );
          case 'legacy_unverifiable': {
            const stored = result.data.storedResponse;
            return errorResponse(
              409,
              'idempotency_legacy_unverifiable',
              'This Idempotency-Key was accepted before request fingerprints existed and cannot be verified. Reconcile it against the already stored opportunity before submitting again.',
              typeof stored.opportunityId === 'string'
                ? { opportunityId: stored.opportunityId }
                : undefined,
            );
          }
        }
      },
      {
        // The raw intake body is bounded to 65,536 actual bytes by the
        // get-stream-backed parse hook BEFORE JSON decoding and domain
        // writes, on every accepted alias of this route. Overflow is mapped
        // to the existing 413 payload_too_large response by the error hook.
        parse: parseIntakeBody,
        error: ({ error, status }) => mapIntakeBodyError(error, status),
      },
    );
