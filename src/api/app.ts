import { logRequest } from './logging';
import { openApiSpecification } from './openapi';
import { mapIntakeBodyError, parseIntakeBody } from '@/api/intake-parser';
import {
  createActivityCommand,
  createContactCommand,
  createCustomFieldCommand,
  createIntakeCommand,
  createManualOpportunityCommand,
  createPipelineCommand,
  createStageCommand,
  deleteContactCommand,
  moveOpportunityCommand,
  updateContactCommand,
  updateOpportunityCommand,
} from '@/application/commands';
import { type DomainError, type PersistenceError } from '@/application/errors';
import {
  bearerToken,
  requireAccessIdentity,
  UnauthorizedError,
} from '@/auth/access';
import {
  archiveFieldDefinition,
  createApiToken,
  type Env,
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
} from '@/db/repository';
import { isIntakeKey } from '@/domain/intake';
import {
  CONTACT_LIMIT_DEFAULT,
  decodeContactCursor,
  parseContactLimit,
} from '@/domain/pagination';
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
  UpdateOpportunitySchema,
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

const requireAdmin = async (request: Request, environment: Env) => {
  try {
    return {
      email: await requireAccessIdentity(request, environment),
    } as const;
  } catch (error) {
    return {
      error: errorResponse(
        401,
        'unauthorized',
        error instanceof UnauthorizedError
          ? error.message
          : 'Authentication is required.',
      ),
    } as const;
  }
};

export const createApp = (environment: Env) =>
  new Elysia({ adapter: CloudflareAdapter, name: 'cloudflare-lead-desk-api' })
    .get('/health', () => ({ ok: true }))
    .get('/openapi', () => Response.json(openApiSpecification))
    .get('/v1/contacts', async ({ query, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

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

      const page = await listContacts(environment, {
        cursor,
        limit,
        query: query.query ?? undefined,
      });
      return { data: page.contacts, nextCursor: page.nextCursor };
    })
    .post('/v1/contacts', async ({ body, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      const parsed = await parse(ContactInputSchema, body);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await run(
        request,
        createContactCommand(environment, parsed.data),
      );
      return 'error' in result
        ? result.error
        : Response.json({ data: result.data }, { status: 201 });
    })
    .get('/v1/contacts/:id', async ({ params, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      const contact = await getContact(environment, params.id);
      return contact
        ? { data: contact }
        : errorResponse(404, 'not_found', 'Contact not found.');
    })
    .put('/v1/contacts/:id', async ({ body, params, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      const parsed = await parse(ContactInputSchema, body);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await run(
        request,
        updateContactCommand(environment, params.id, parsed.data),
      );
      if ('error' in result) {
        return result.error;
      }

      return result.data
        ? { data: result.data }
        : errorResponse(404, 'not_found', 'Contact not found.');
    })
    .delete('/v1/contacts/:id', async ({ params, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      const result = await run(
        request,
        deleteContactCommand(environment, params.id),
      );
      if ('error' in result) {
        return result.error;
      }

      if (result.data === 'deleted') {
        return new Response(null, { status: 204 });
      }

      if (result.data === 'has_opportunities') {
        return errorResponse(
          409,
          'contact_has_opportunities',
          'Contacts with opportunities cannot be deleted.',
        );
      }

      return errorResponse(404, 'not_found', 'Contact not found.');
    })
    .post('/v1/opportunities', async ({ body, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      const parsed = await parse(CreateOpportunitySchema, body);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await run(
        request,
        createManualOpportunityCommand(environment, parsed.data, admin.email),
      );
      if ('error' in result) {
        return result.error;
      }

      if (result.data === 'contact_not_found') {
        return errorResponse(404, 'not_found', 'Contact not found.');
      }

      if (result.data === 'invalid_stage') {
        return errorResponse(
          422,
          'invalid_stage',
          'The selected stage does not belong to this pipeline.',
        );
      }

      return Response.json({ data: result.data }, { status: 201 });
    })
    .get('/v1/opportunities', async ({ query, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      const pipelineId = query.pipelineId;
      if (pipelineId !== undefined) {
        // The filter only accepts pipelines of the current workspace that
        // are not archived; anything else is rejected before listing.
        const pipeline =
          typeof pipelineId === 'string'
            ? await getPipeline(environment, pipelineId)
            : null;
        if (!pipeline || pipeline.archivedAt !== null) {
          return errorResponse(
            422,
            'validation_error',
            'pipelineId must reference an active pipeline of the current workspace.',
          );
        }
      }

      return { data: await listOpportunities(environment, pipelineId) };
    })
    .get('/v1/opportunities/:id', async ({ params, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      const opportunity = await getOpportunity(environment, params.id);
      return opportunity
        ? { data: opportunity }
        : errorResponse(404, 'not_found', 'Opportunity not found.');
    })
    .patch('/v1/opportunities/:id', async ({ body, params, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      const parsed = await parse(UpdateOpportunitySchema, body);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await run(
        request,
        updateOpportunityCommand(environment, params.id, parsed.data),
      );
      if ('error' in result) {
        return result.error;
      }

      return result.data
        ? { data: result.data }
        : errorResponse(404, 'not_found', 'Opportunity not found.');
    })
    .post('/v1/opportunities/:id/move', async ({ body, params, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      const parsed = await parse(MoveOpportunitySchema, body);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await run(
        request,
        moveOpportunityCommand(
          environment,
          params.id,
          parsed.data.stageId,
          admin.email,
        ),
      );
      if ('error' in result) {
        return result.error;
      }

      return result.data
        ? { data: result.data }
        : errorResponse(404, 'not_found', 'Opportunity not found.');
    })
    .get('/v1/opportunities/:id/activities', async ({ params, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      return { data: await listActivities(environment, params.id) };
    })
    .post(
      '/v1/opportunities/:id/activities',
      async ({ body, params, request }) => {
        const admin = await requireAdmin(request, environment);
        if ('error' in admin) {
          return admin.error;
        }

        const parsed = await parse(CreateActivitySchema, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const result = await run(
          request,
          createActivityCommand(
            environment,
            params.id,
            admin.email,
            parsed.data.kind ?? 'note',
            parsed.data.body,
          ),
        );
        if ('error' in result) {
          return result.error;
        }

        return result.data
          ? Response.json({ data: result.data }, { status: 201 })
          : errorResponse(404, 'not_found', 'Opportunity not found.');
      },
    )
    .get('/v1/pipelines', async ({ request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      return { data: await listPipelines(environment) };
    })
    .post('/v1/pipelines', async ({ body, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      const parsed = await parse(CreatePipelineSchema, body);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await run(
        request,
        createPipelineCommand(environment, parsed.data.name),
      );
      return 'error' in result
        ? result.error
        : Response.json({ data: result.data }, { status: 201 });
    })
    .post('/v1/pipelines/:id/stages', async ({ body, params, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      const parsed = await parse(CreateStageSchema, body);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await run(
        request,
        createStageCommand(environment, params.id, parsed.data),
      );
      return 'error' in result
        ? result.error
        : Response.json({ data: result.data }, { status: 201 });
    })
    .get('/v1/custom-fields', async ({ query, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      if (
        query.entityType !== 'contact' &&
        query.entityType !== 'opportunity'
      ) {
        return errorResponse(
          422,
          'validation_error',
          'entityType is required.',
        );
      }

      return { data: await getFieldDefinitions(environment, query.entityType) };
    })
    .post('/v1/custom-fields', async ({ body, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      const parsed = await parse(CreateCustomFieldSchema, body);
      if ('error' in parsed) {
        return parsed.error;
      }

      if (
        parsed.data.type === 'select' &&
        (!parsed.data.options || parsed.data.options.length === 0)
      ) {
        return errorResponse(
          422,
          'validation_error',
          'Select fields need at least one option.',
        );
      }

      const result = await run(
        request,
        createCustomFieldCommand(environment, parsed.data),
      );
      return 'error' in result
        ? result.error
        : Response.json({ data: result.data }, { status: 201 });
    })
    .delete('/v1/custom-fields/:id', async ({ params, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      return (await archiveFieldDefinition(environment, params.id))
        ? new Response(null, { status: 204 })
        : errorResponse(404, 'not_found', 'Custom field not found.');
    })
    .get('/v1/tokens', async ({ request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      return { data: await listApiTokens(environment) };
    })
    .post('/v1/tokens', async ({ body, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      const parsed = await parse(CreateTokenSchema, body);
      if ('error' in parsed) {
        return parsed.error;
      }

      return Response.json(
        { data: await createApiToken(environment, parsed.data.name) },
        { status: 201 },
      );
    })
    .delete('/v1/tokens/:id', async ({ params, request }) => {
      const admin = await requireAdmin(request, environment);
      if ('error' in admin) {
        return admin.error;
      }

      return (await revokeApiToken(environment, params.id))
        ? new Response(null, { status: 204 })
        : errorResponse(404, 'not_found', 'Token not found.');
    })
    .post(
      '/v1/intakes',
      async ({ body, request }) => {
        const token = bearerToken(request);
        if (!token || !(await isIntakeToken(environment, token))) {
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

        const parsed = await parse(IntakeInputSchema, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const result = await run(
          request,
          createIntakeCommand(environment, parsed.data, idempotencyKey),
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
            // compatibility, without touching contacts or history.
            return Response.json(
              { data: result.data.response },
              { status: 201 },
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
    );
