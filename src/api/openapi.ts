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
      put: { responses: { 200: { description: 'Contact updated' }, 401: { description: 'Access required' }, 404: { description: 'Contact not found' }, 422: { description: 'Invalid contact' } }, summary: 'Update contact' },
    },
    '/v1/intakes': {
      post: {
        parameters: [{ in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string' } }],
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
        responses: { 201: { description: 'Intake captured' }, 401: { description: 'Intake token required' }, 422: { description: 'Invalid intake' } },
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
