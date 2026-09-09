export const openApiSpecification = {
  info: {
    title: 'Cloudflare Lead Desk API',
    version: '0.1.0-alpha.0',
  },
  openapi: '3.1.0',
  paths: {
    '/health': {
      get: { responses: { 200: { description: 'Healthy Worker' } }, summary: 'Health check' },
    },
    '/v1/contacts': {
      get: { responses: { 200: { description: 'Contact list' }, 401: { description: 'Access required' } }, summary: 'List contacts' },
      post: { responses: { 201: { description: 'Contact created' }, 401: { description: 'Access required' }, 422: { description: 'Invalid contact' } }, summary: 'Create contact' },
    },
    '/v1/contacts/{id}': {
      delete: { responses: { 204: { description: 'Contact deleted' }, 404: { description: 'Contact not found' }, 409: { description: 'Contact has opportunities' } }, summary: 'Delete contact' },
      get: { responses: { 200: { description: 'Contact' }, 401: { description: 'Access required' }, 404: { description: 'Contact not found' } }, summary: 'Get contact' },
      put: {
        description: 'Update a contact. `customFields` is a patch: omit the object or a key to keep its stored value, or send an explicit `null` to clear an optional field. Required fields cannot be cleared or left without a value, unknown or archived keys are rejected, and the core fields plus all field writes commit in a single transaction.',
        responses: { 200: { description: 'Contact updated' }, 401: { description: 'Access required' }, 404: { description: 'Contact not found' }, 422: { description: 'Invalid contact' } },
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
          'Size: the raw request body is limited to 65,536 actual bytes (streamed or declared) before JSON parsing; larger bodies return 413 payload_too_large. Other routes are not size-limited here.',
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
          201: { description: 'Intake captured, or the stored response replayed for a matching retry' },
          400: {
            description: 'Idempotency-Key missing (idempotency_key_required) or not 1-128 printable ASCII (invalid_idempotency_key)',
          },
          401: { description: 'Missing, invalid, or revoked intake token' },
          409: {
            description: 'idempotency_conflict (same key, different payload) or idempotency_legacy_unverifiable (pre-fingerprint key; reconcile against the stored opportunity first)',
          },
          413: { description: 'payload_too_large (raw body over 65,536 bytes)' },
          422: {
            description: 'Invalid intake payload, custom-field value, or invalid_stage (stage/pipeline/workspace mismatch or archived pipeline)',
          },
        },
        security: [{ bearerAuth: [] }],
        summary: 'Atomically capture a contact and opportunity',
      },
    },
    '/v1/opportunities': {
      get: { responses: { 200: { description: 'Opportunity list' }, 401: { description: 'Access required' } }, summary: 'List opportunities' },
      post: { responses: { 201: { description: 'Opportunity created' }, 401: { description: 'Access required' }, 404: { description: 'Contact not found' }, 422: { description: 'Invalid opportunity' } }, summary: 'Create opportunity' },
    },
    '/v1/pipelines': {
      get: { responses: { 200: { description: 'Pipelines and stages' }, 401: { description: 'Access required' } }, summary: 'List pipelines' },
      post: { responses: { 201: { description: 'Pipeline created' }, 401: { description: 'Access required' } }, summary: 'Create pipeline' },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { bearerFormat: 'token', scheme: 'bearer', type: 'http' },
    },
  },
} as const;
