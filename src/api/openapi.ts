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
    '/health': {
      get: {
        responses: { '200': { description: 'Healthy Worker' } },
        summary: 'Health check',
      },
    },
    '/v1/contacts': {
      get: {
        description: [
          'Lists contacts, newest first (createdAt DESC, tie-broken by id DESC), with keyset (seek) pagination.',
          '',
          "Pagination: `limit` (integer 1-100, default 50) bounds the page size. `cursor` takes the opaque `nextCursor` from a previous response - a base64url-encoded keyset over the last row's (createdAt, id); omit it for the first page. The final page returns `nextCursor: null`. A non-numeric or out-of-range limit returns 422 validation_error; a missing, malformed, or tampered cursor returns 422 invalid_cursor.",
          '',
          "Each item keeps the flat contact shape, including `customFields`. Custom-field values are fetched for the whole page in batched queries (chunked to D1's 100-bound-parameter limit), not one query per contact.",
        ].join('\n'),
        parameters: [
          {
            description:
              'Search. Literal substring match on first name, last name, or email; `%` and `_` match literally.',
            in: 'query',
            name: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            description: 'Page size (1-100, default 50)',
            in: 'query',
            name: 'limit',
            required: false,
            schema: { default: 50, maximum: 100, minimum: 1, type: 'integer' },
          },
          {
            description: 'Opaque keyset cursor from a previous response',
            in: 'query',
            name: 'cursor',
            required: false,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description:
              'One page: { data: [contacts], nextCursor: string | null }',
          },
          '401': { description: 'Access required' },
          '422': {
            description:
              'validation_error (limit) or invalid_cursor (malformed or tampered cursor)',
          },
        },
        summary: 'List contacts (keyset pagination)',
      },
      post: {
        responses: {
          '201': { description: 'Contact created' },
          '401': { description: 'Access required' },
          '422': { description: 'Invalid contact' },
        },
        summary: 'Create contact',
      },
    },
    '/v1/contacts/{id}': {
      delete: {
        responses: {
          '204': { description: 'Contact deleted' },
          '404': { description: 'Contact not found' },
          '409': { description: 'Contact has opportunities' },
        },
        summary: 'Delete contact',
      },
      get: {
        responses: {
          '200': { description: 'Contact' },
          '401': { description: 'Access required' },
          '404': { description: 'Contact not found' },
        },
        summary: 'Get contact',
      },
      put: {
        description:
          'Update a contact. `customFields` is a patch: omit the object or a key to keep its stored value, or send an explicit `null` to clear an optional field. Required fields cannot be cleared or left without a value, unknown or archived keys are rejected, and the core fields plus all field writes commit in a single transaction.',
        responses: {
          '200': { description: 'Contact updated' },
          '401': { description: 'Access required' },
          '404': { description: 'Contact not found' },
          '422': { description: 'Invalid contact' },
        },
        summary: 'Update contact',
      },
    },
    '/v1/intakes': {
      post: {
        description: [
          'Atomically captures a contact, opportunity, intake activity, custom-field values, and the idempotency key in one D1 transaction.',
          '',
          'Idempotency contract:',
          '- The Idempotency-Key header is required: 1-128 printable ASCII characters (0x21-0x7E, no spaces). Missing or invalid keys are rejected with 400 before any intake data is written.',
          '- Keys are workspace-scoped and persist across token rotation: a rotated token replays the stored response instead of duplicating the submission.',
          '- A deterministic SHA-256 fingerprint of the decoded request (object keys sorted, array order preserved, email normalized) is stored with the accepted key. Re-sending the same logical payload - any JSON whitespace or property order, any email case - returns the original 201 response and IDs without updating contacts or inserting history.',
          '- A different payload under the same key returns 409 idempotency_conflict without exposing the stored payload or hash.',
          '- Keys accepted before fingerprints existed (null request_hash) return 409 idempotency_legacy_unverifiable. Reconcile them against the already stored opportunity (returned in details) before submitting again; the row is never overwritten, backfilled, or deleted.',
          '- Replays skip current custom-field and pipeline validation, so an accepted submission keeps replaying after fields are archived or newly required and after pipelines are archived.',
          '',
          'Routing: the selected (or default) stage must belong to the selected (or default) pipeline, both must belong to the current workspace, and archived pipelines are rejected with 422 invalid_stage. No intake data is written for rejected routing.',
          '',
          'Size: the raw request body is limited to 65,536 actual bytes (streamed or declared) before JSON parsing and domain writes, on every accepted alias of this route; larger bodies return 413 payload_too_large and the open input stream is cancelled. Other routes are not size-limited here.',
        ].join('\n'),
        parameters: [
          {
            in: 'header',
            name: 'Idempotency-Key',
            required: true,
            schema: {
              maxLength: 128,
              minLength: 1,
              pattern: '^[\\u0021-\\u007e]{1,128}$',
              type: 'string',
            },
          },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                properties: {
                  contact: { type: 'object' },
                  opportunity: { type: 'object' },
                  source: { type: 'string' },
                },
                required: ['contact', 'opportunity', 'source'],
                type: 'object',
              },
            },
          },
          required: true,
        },
        responses: {
          '201': {
            description:
              'Intake captured, or the stored response replayed for a matching retry',
          },
          '400': {
            description:
              'Idempotency-Key missing (idempotency_key_required) or not 1-128 printable ASCII (invalid_idempotency_key)',
          },
          '401': { description: 'Missing, invalid, or revoked intake token' },
          '409': {
            description:
              'idempotency_conflict (same key, different payload) or idempotency_legacy_unverifiable (pre-fingerprint key; reconcile against the stored opportunity first)',
          },
          '413': {
            description:
              'payload_too_large (raw body over 65,536 bytes, regardless of media type)',
          },
          '415': {
            description:
              'unsupported_media_type (Content-Type must be application/json)',
          },
          '422': {
            description:
              'Invalid intake payload, custom-field value, or invalid_stage (stage/pipeline/workspace mismatch or archived pipeline)',
          },
        },
        security: [{ bearerAuth: [] }],
        summary: 'Atomically capture a contact and opportunity',
      },
    },
    '/v1/opportunities': {
      get: {
        description:
          "Lists opportunities, newest first. Not paginated; the optional `pipelineId` query parameter restricts results to one active pipeline of the current workspace. An unknown or archived pipelineId returns 422 validation_error. Custom-field values are fetched for the whole list in batched queries (chunked to D1's 100-bound-parameter limit), not one query per opportunity.",
        parameters: [
          {
            description:
              'Restrict to one active pipeline of the current workspace',
            in: 'query',
            name: 'pipelineId',
            required: false,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': { description: 'Opportunity list' },
          '401': { description: 'Access required' },
          '422': {
            description: 'validation_error (unknown or archived pipelineId)',
          },
        },
        summary: 'List opportunities (optional pipeline filter)',
      },
      post: {
        responses: {
          '201': { description: 'Opportunity created' },
          '401': { description: 'Access required' },
          '404': { description: 'Contact not found' },
          '422': { description: 'Invalid opportunity' },
        },
        summary: 'Create opportunity',
      },
    },
    '/v1/opportunities/{id}': {
      patch: {
        description:
          'Update an opportunity. At least one of `name` (non-empty, no leading or trailing whitespace - the app-wide NonEmptyString contract) or `estimatedValue` (non-negative finite number, or an explicit `null` to clear it) is required. Omitted fields keep their stored values; an empty object or a whitespace-only name returns 422 validation_error, as do negative or non-finite values.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                properties: {
                  estimatedValue: {
                    anyOf: [{ type: 'number' }, { type: 'null' }],
                  },
                  name: { type: 'string' },
                },
                type: 'object',
              },
            },
          },
          required: true,
        },
        responses: {
          '200': { description: 'Opportunity updated' },
          '401': { description: 'Access required' },
          '404': { description: 'Opportunity not found' },
          '422': {
            description:
              'validation_error (no fields, whitespace name, or negative or non-finite estimatedValue)',
          },
        },
        summary: 'Update opportunity name and estimated value',
      },
    },
    '/v1/pipelines': {
      get: {
        responses: {
          '200': { description: 'Pipelines and stages' },
          '401': { description: 'Access required' },
        },
        summary: 'List pipelines',
      },
      post: {
        responses: {
          '201': { description: 'Pipeline created' },
          '401': { description: 'Access required' },
        },
        summary: 'Create pipeline',
      },
    },
  },
} as const;
