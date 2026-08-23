import { Effect, Either, Schema } from 'effect';
import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';
import { openApiSpecification } from './openapi';
import {
  createActivityCommand,
  createContactCommand,
  createCustomFieldCommand,
  createIntakeCommand,
  createPipelineCommand,
  createStageCommand,
  moveOpportunityCommand,
} from '@/application/commands';
import { DomainError, PersistenceError } from '@/application/errors';
import { UnauthorizedError, bearerToken, requireAccessIdentity } from '@/auth/access';
import {
  archiveFieldDefinition,
  createApiToken,
  getContact,
  getFieldDefinitions,
  getOpportunity,
  isIntakeToken,
  listActivities,
  listApiTokens,
  listContacts,
  listOpportunities,
  listPipelines,
  revokeApiToken,
  seedDefaults,
  type Env,
} from '@/db/repository';
import {
  ContactInputSchema,
  CreateActivitySchema,
  CreateCustomFieldSchema,
  CreatePipelineSchema,
  CreateStageSchema,
  CreateTokenSchema,
  IntakeInputSchema,
  MoveOpportunitySchema,
} from '@/domain/schemas';

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
    .onRequest(async () => {
      await seedDefaults(env);
    })
    .get('/health', () => ({ ok: true }))
    .get('/openapi', () => Response.json(openApiSpecification))
    .get('/v1/contacts', async ({ request, query }) => {
      const admin = await requireAdmin(request, env);
      if ('error' in admin) return admin.error;
      return { data: await listContacts(env, query.query) };
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
    .get('/v1/opportunities', async ({ request }) => {
      const admin = await requireAdmin(request, env);
      if ('error' in admin) return admin.error;
      return { data: await listOpportunities(env) };
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
        const parsed = await parse(IntakeInputSchema, body);
        if ('error' in parsed) return parsed.error;
        const result = await run(createIntakeCommand(env, parsed.data, idempotencyKey));
        return 'error' in result ? result.error : Response.json({ data: result.data }, { status: 201 });
      }
    );
