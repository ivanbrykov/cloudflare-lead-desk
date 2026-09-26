import { logRequest } from './logging';
import { openApiSpecification } from './openapi';
import { mapIntakeBodyError, parseIntakeBody } from '@/api/intake-parser';
import {
  createActivityCommand,
  createContactCommand,
  createCustomFieldCommand,
  createIntakeCommand,
  createLeadActivityCommand,
  createLeadCommand,
  createManualOpportunityCommand,
  createPipelineCommand,
  createStageCommand,
  deleteContactCommand,
  moveLeadsCommand,
  moveOpportunityCommand,
  softDeleteLeadsCommand,
  updateContactCommand,
  updateLeadCommand,
  updateOpportunityCommand,
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
import { handleDisabledAccountSignIn } from '@/auth/sign-in-guard';
import {
  archiveFieldDefinition,
  checkStaffInviteAvailability,
  countLeadsByStage,
  createApiToken,
  createStaffInvite,
  type Env,
  getContact,
  getFieldDefinitions,
  getLead,
  getOpportunity,
  getPipeline,
  isBootstrapGrantAvailable,
  isIntakeToken,
  listActivities,
  listApiTokens,
  listContacts,
  listLeadActivities,
  listLeads,
  listOpportunities,
  listPipelines,
  listStaffAccounts,
  listStaffInvites,
  revokeApiToken,
  revokeStaffInvite,
  setStaffAccountDisabled,
  softDeleteOpportunity,
} from '@/db/repository';
import { isIntakeKey } from '@/domain/intake';
import {
  decodeKeysetCursor,
  LIST_LIMIT_DEFAULT,
  parseListLimit,
} from '@/domain/pagination';
import {
  BulkDeleteLeadsRequest,
  BulkMoveLeadsRequest,
  ContactInputRequest,
  CreateActivityRequest,
  CreateCustomFieldRequest,
  CreateInviteRequest,
  CreateLeadActivityRequest,
  CreateLeadRequest,
  CreateOpportunityRequest,
  CreatePipelineRequest,
  CreateStageRequest,
  CreateTokenRequest,
  HealthResponse,
  IntakeRequest,
  LeadStageCountsQueryRequest,
  ListLeadsQueryRequest,
  MoveOpportunityRequest,
  SetStaffDisabledRequest,
  UpdateLeadRequest,
  UpdateOpportunityRequest,
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

const createAppWithAuth = (environment: Env, getAuth: AuthForRequest) =>
  new Elysia({ adapter: CloudflareAdapter, name: 'cloudflare-lead-desk-api' })
    // Elysia's mount() strips the mount prefix before forwarding. Better Auth
    // expects its full basePath, so re-add the prefix to the cloned request.
    // POST /sign-up/email is the invitation boundary: it resolves the grant
    // before any account write and re-issues the session through Better
    // Auth's sign-in endpoint.
    .mount('/api/auth', (request: Request) => {
      try {
        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === '/sign-up/email') {
          return handleInvitationSignUp(environment, request, getAuth);
        }

        if (request.method === 'POST' && url.pathname === '/sign-in/email') {
          return handleDisabledAccountSignIn(environment, request, getAuth);
        }

        url.pathname = `/api/auth${url.pathname}`;
        return getAuth(request).handler(new Request(url, request));
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
    .get('/openapi', () => Response.json(openApiSpecification))
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

        const parsed = await parse(IntakeRequest, body);
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
    .post('/api/invites/validate', async ({ body, request }) => {
      // Trusted-origin check for hostile browser Origin headers: compare
      // against BETTER_AUTH_URL or, when unset, the incoming request.url
      // origin. Forwarded headers are never consulted; a missing Origin
      // (non-browser clients) is allowed, consistent with the auth routes.
      const origin = request.headers.get('Origin');
      if (origin !== null) {
        let trusted: string;
        try {
          trusted = resolveAuthOrigin(environment, request);
        } catch (error) {
          if (error instanceof AuthConfigurationError) {
            return authenticationNotConfiguredResponse();
          }

          throw error;
        }

        if (origin !== trusted) {
          return errorResponse(
            403,
            'forbidden',
            'The request origin is not trusted.',
          );
        }
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
    // the guard. Non-staff routes (auth mount, health, openapi, intakes,
    // invite validation) are registered above this hook.
    .resolve(async ({ request }) => {
      const admin = await requireAdmin(request, getAuth, environment);
      if ('error' in admin) {
        throw admin.error;
      }

      return { adminEmail: admin.email };
    })
    .get('/v1/contacts', async ({ query }) => {
      const limit =
        query.limit === undefined
          ? LIST_LIMIT_DEFAULT
          : parseListLimit(query.limit);
      if (limit === null) {
        return errorResponse(
          422,
          'validation_error',
          'limit must be an integer between 1 and 100.',
        );
      }

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

      const page = await listContacts(environment, {
        cursor,
        limit,
        query: query.query ?? undefined,
      });
      return { data: page.contacts, nextCursor: page.nextCursor };
    })
    .post('/v1/contacts', async ({ body, request }) => {
      const parsed = await parse(ContactInputRequest, body);
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
    .get('/v1/contacts/:id', async ({ params }) => {
      const contact = await getContact(environment, params.id);
      return contact
        ? { data: contact }
        : errorResponse(404, 'not_found', 'Contact not found.');
    })
    .put('/v1/contacts/:id', async ({ body, params, request }) => {
      const parsed = await parse(ContactInputRequest, body);
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
    .post('/v1/opportunities', async ({ adminEmail, body, request }) => {
      const parsed = await parse(CreateOpportunityRequest, body);
      if ('error' in parsed) {
        return parsed.error;
      }

      const result = await run(
        request,
        createManualOpportunityCommand(environment, parsed.data, adminEmail),
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
    .get('/v1/opportunities', async ({ query }) => {
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
    .get('/v1/opportunities/:id', async ({ params }) => {
      const opportunity = await getOpportunity(environment, params.id);
      return opportunity
        ? { data: opportunity }
        : errorResponse(404, 'not_found', 'Opportunity not found.');
    })
    .patch('/v1/opportunities/:id', async ({ body, params, request }) => {
      const parsed = await parse(UpdateOpportunityRequest, body);
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
    .delete('/v1/opportunities/:id', async ({ params }) => {
      return (await softDeleteOpportunity(environment, params.id))
        ? new Response(null, { status: 204 })
        : errorResponse(404, 'not_found', 'Opportunity not found.');
    })
    .post(
      '/v1/opportunities/:id/move',
      async ({ adminEmail, body, params, request }) => {
        const parsed = await parse(MoveOpportunityRequest, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const result = await run(
          request,
          moveOpportunityCommand(
            environment,
            params.id,
            parsed.data.stageId,
            adminEmail,
          ),
        );
        if ('error' in result) {
          return result.error;
        }

        return result.data
          ? { data: result.data }
          : errorResponse(404, 'not_found', 'Opportunity not found.');
      },
    )
    .get('/v1/opportunities/:id/activities', async ({ params }) => {
      return { data: await listActivities(environment, params.id) };
    })
    .post(
      '/v1/opportunities/:id/activities',
      async ({ adminEmail, body, params, request }) => {
        const parsed = await parse(CreateActivityRequest, body);
        if ('error' in parsed) {
          return parsed.error;
        }

        const result = await run(
          request,
          createActivityCommand(
            environment,
            params.id,
            adminEmail,
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
    .get('/v1/pipelines', async () => {
      return { data: await listPipelines(environment) };
    })
    .post(
      '/v1/pipelines',
      async ({ body, request }) => {
        const result = await run(
          request,
          createPipelineCommand(environment, body.name),
        );
        return 'error' in result
          ? result.error
          : Response.json({ data: result.data }, { status: 201 });
      },
      { body: Schema.standardSchemaV1(CreatePipelineRequest) },
    )
    .post('/v1/pipelines/:id/stages', async ({ body, params, request }) => {
      const parsed = await parse(CreateStageRequest, body);
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
    .get(
      '/v1/leads/stage-counts',
      async ({ query }) => {
        return {
          data: await countLeadsByStage(environment, query.pipelineId),
        };
      },
      { query: Schema.standardSchemaV1(LeadStageCountsQueryRequest) },
    )
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
          pipelineId: query.pipelineId,
          query: query.query,
          stageId: query.stageId,
        });
        return { data: page.leads, nextCursor: page.nextCursor };
      },
      { query: Schema.standardSchemaV1(ListLeadsQueryRequest) },
    )
    .post(
      '/v1/leads',
      async ({ body, request }) => {
        const result = await run(request, createLeadCommand(environment, body));
        return 'error' in result
          ? result.error
          : Response.json({ data: result.data }, { status: 201 });
      },
      { body: Schema.standardSchemaV1(CreateLeadRequest) },
    )
    .patch(
      '/v1/leads/bulk',
      async ({ body, request }) => {
        const result = await run(
          request,
          moveLeadsCommand(environment, body.ids, body.stageId),
        );
        if ('error' in result) {
          return result.error;
        }

        switch (result.data) {
          case 'invalid_stage':
            return errorResponse(
              422,
              'invalid_stage',
              "The selected stage does not belong to these leads' pipeline.",
            );
          case 'moved':
            return { data: { moved: body.ids.length } };
          case 'not_found':
            return errorResponse(
              404,
              'not_found',
              'One or more leads were not found.',
            );
        }

        return undefined;
      },
      { body: Schema.standardSchemaV1(BulkMoveLeadsRequest) },
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

        if (result.data === 'invalid_stage') {
          return errorResponse(
            422,
            'invalid_stage',
            "The selected stage does not belong to this lead's pipeline.",
          );
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
    .get('/v1/custom-fields', async ({ query }) => {
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
      const parsed = await parse(CreateCustomFieldRequest, body);
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
    .delete('/v1/custom-fields/:id', async ({ params }) => {
      return (await archiveFieldDefinition(environment, params.id))
        ? new Response(null, { status: 204 })
        : errorResponse(404, 'not_found', 'Custom field not found.');
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
          data: await createApiToken(
            environment,
            parsed.data.name,
            parsed.data.expiresAt,
          ),
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
    });

export const createApp = (environment: Env) =>
  createAppWithAuth(environment, (request) => createAuth(environment, request));
