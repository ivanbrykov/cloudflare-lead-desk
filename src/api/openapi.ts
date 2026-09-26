const leadSchema = {
  properties: {
    customFields: { additionalProperties: true, type: 'object' },
    email: { type: ['string', 'null'] },
    estimatedValue: { type: ['number', 'null'] },
    firstName: { type: ['string', 'null'] },
    id: { type: 'string' },
    lastName: { type: ['string', 'null'] },
    name: { type: 'string' },
    pipelineId: { type: 'string' },
    source: { type: 'string' },
    stageId: { type: 'string' },
  },
  required: ['id', 'name', 'pipelineId', 'source', 'stageId'],
  type: 'object',
} as const;

const validationError = { description: 'validation_error' } as const;

export const openApiSpecification = {
  components: {
    securitySchemes: {
      bearerAuth: { bearerFormat: 'token', scheme: 'bearer', type: 'http' },
    },
  },
  info: {
    title: 'Cloudflare Lead Desk API',
    version: '0.1.0-alpha.0',
  },
  openapi: '3.1.0',
  paths: {
    '/api/invites/validate': {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                properties: { token: { type: 'string' } },
                required: ['token'],
                type: 'object',
              },
            },
          },
          required: true,
        },
        responses: {
          '200': {
            description: '{ valid: true } when the grant is still usable',
          },
          '403': {
            description:
              'invite_unavailable (used, revoked, expired, unknown, or bootstrap already consumed)',
          },
          '422': validationError,
        },
        summary: 'Check whether an invite or bootstrap token is still usable',
      },
    },
    '/health': {
      get: {
        responses: { '200': { description: 'Healthy Worker' } },
        summary: 'Health check',
      },
    },
    '/v1/intakes': {
      post: {
        description:
          'The secret-token integration endpoint. One submission creates one lead. Idempotency-Key makes retries safe; the raw body is byte-limited to 65,536 bytes.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                properties: {
                  customFields: {
                    additionalProperties: true,
                    type: 'object',
                  },
                  email: { type: 'string' },
                  estimatedValue: { type: 'number' },
                  firstName: { type: 'string' },
                  lastName: { type: 'string' },
                  name: { type: 'string' },
                  pipelineId: { type: 'string' },
                  source: { type: 'string' },
                  stageId: { type: 'string' },
                },
                required: ['email', 'source'],
                type: 'object',
              },
            },
          },
          required: true,
        },
        responses: {
          '201': { description: '{ data: { created, leadId } }' },
          '400': { description: 'invalid_json or fingerprint errors' },
          '401': { description: 'Missing or invalid intake token' },
          '409': {
            description:
              'idempotency_conflict or idempotency_legacy_unverifiable',
          },
          '413': { description: 'payload_too_large (over 65,536 bytes)' },
          '415': { description: 'unsupported_media_type' },
          '422': validationError,
        },
        security: [{ bearerAuth: [] }],
        summary: 'Create a lead from a trusted server integration',
      },
    },
    '/v1/leads': {
      get: {
        description:
          'Lists leads, newest first, with keyset (seek) pagination and a per-page duplicate-email hint. Optional `pipelineId`, `stageId`, and `query` filters.',
        parameters: [
          { in: 'query', name: 'pipelineId', schema: { type: 'string' } },
          { in: 'query', name: 'stageId', schema: { type: 'string' } },
          { in: 'query', name: 'query', schema: { type: 'string' } },
          { in: 'query', name: 'cursor', schema: { type: 'string' } },
          { in: 'query', name: 'limit', schema: { type: 'integer' } },
        ],
        responses: {
          '200': { description: '{ data: [lead], nextCursor: string | null }' },
          '422': validationError,
        },
        summary: 'List leads',
      },
      post: {
        requestBody: {
          content: { 'application/json': { schema: leadSchema } },
          required: true,
        },
        responses: {
          '201': { description: '{ data: lead }' },
          '422': {
            description: 'validation_error or lead_identity_required',
          },
        },
        summary: 'Create a lead manually',
      },
    },
    '/v1/leads/bulk': {
      patch: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                properties: {
                  ids: { items: { type: 'string' }, type: 'array' },
                  stageId: { type: 'string' },
                },
                required: ['ids', 'stageId'],
                type: 'object',
              },
            },
          },
          required: true,
        },
        responses: {
          '200': { description: 'Moved' },
          '404': { description: 'not_found' },
          '422': { description: 'invalid_stage or validation_error' },
        },
        summary: 'Move leads to a stage',
      },
    },
    '/v1/leads/bulk-delete': {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                properties: {
                  ids: { items: { type: 'string' }, type: 'array' },
                },
                required: ['ids'],
                type: 'object',
              },
            },
          },
          required: true,
        },
        responses: {
          '200': { description: 'Soft-deleted' },
          '404': { description: 'not_found' },
          '422': validationError,
        },
        summary: 'Soft-delete leads',
      },
    },
    '/v1/leads/stage-counts': {
      get: {
        parameters: [
          { in: 'query', name: 'pipelineId', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: '[{ count, stageId }]' },
          '422': validationError,
        },
        summary: 'Count live leads per stage',
      },
    },
    '/v1/leads/{id}': {
      get: {
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': { description: '{ data: lead }' },
          '404': { description: 'not_found' },
        },
        summary: 'Get a lead',
      },
      patch: {
        description:
          'Partial update. `email`, `firstName`, and `lastName` accept `null` to clear; `customFields` replaces the JSON document.',
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          content: { 'application/json': { schema: leadSchema } },
          required: true,
        },
        responses: {
          '200': { description: '{ data: lead }' },
          '404': { description: 'not_found' },
          '422': { description: 'invalid_stage or validation_error' },
        },
        summary: 'Update a lead',
      },
    },
    '/v1/leads/{id}/activities': {
      get: {
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: { '200': { description: '[activity]' } },
        summary: 'List a lead’s activity',
      },
      post: {
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                properties: { body: { type: 'string' } },
                required: ['body'],
                type: 'object',
              },
            },
          },
          required: true,
        },
        responses: {
          '201': { description: '{ data: activity }' },
          '404': { description: 'not_found' },
          '422': validationError,
        },
        summary: 'Add a note to a lead',
      },
    },
    '/v1/pipelines': {
      get: {
        responses: {
          '200': { description: '{ data: [pipeline with stages] }' },
        },
        summary: 'List pipelines with their stages',
      },
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                properties: { name: { type: 'string' } },
                required: ['name'],
                type: 'object',
              },
            },
          },
          required: true,
        },
        responses: {
          '201': { description: '{ data: pipeline }' },
          '422': validationError,
        },
        summary: 'Create a pipeline',
      },
    },
    '/v1/pipelines/{id}/stages': {
      post: {
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                properties: {
                  color: { type: 'string' },
                  name: { type: 'string' },
                  position: { type: 'integer' },
                },
                required: ['name'],
                type: 'object',
              },
            },
          },
          required: true,
        },
        responses: {
          '201': { description: '{ data: stage }' },
          '422': validationError,
        },
        summary: 'Add a stage to a pipeline',
      },
    },
    '/v1/tokens': {
      get: {
        responses: { '200': { description: '{ data: [token] }' } },
        summary: 'List intake tokens (prefixes only)',
      },
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                properties: {
                  expiresAt: { type: 'string' },
                  name: { type: 'string' },
                },
                required: ['name'],
                type: 'object',
              },
            },
          },
          required: true,
        },
        responses: {
          '201': { description: '{ data: token } — value shown once' },
          '422': validationError,
        },
        summary: 'Create an intake token',
      },
    },
    '/v1/tokens/{id}': {
      delete: {
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '204': { description: 'Revoked' },
          '404': { description: 'not_found' },
        },
        summary: 'Revoke an intake token',
      },
    },
  },
  security: [{ bearerAuth: [] }],
} as const;
