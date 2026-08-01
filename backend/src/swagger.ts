import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Fruiterie ERP API',
      version: '0.1.0',
      description:
        'API de gestion pour grossiste fruits/légumes (Algérie, DA). Phase A : fondations + auth + référentiels. Modules métier documentés mais retournant 501.',
    },
    servers: [{ url: 'http://localhost:8080', description: 'Serveur local dev (Phase A)' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'fruiterie_refresh' },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string' }, message: { type: 'string' } },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ['./src/**/*.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
