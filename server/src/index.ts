import fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import dotenv from 'dotenv';
import { createServer } from 'https';
import { readFileSync } from 'fs';
import path from 'path';

// Load environment variables
dotenv.config();

// Import custom modules
import { initializePostgres, initializeRedis, runMigrations, healthCheck, shutdown as dbShutdown } from './database/connection';
import { authenticate, generateTokens, refreshAccessToken, validateVRCXAuth } from './middleware/auth';
import { rateLimiters, combinedRateLimiter } from './middleware/rateLimiter';
import { errorHandler, notFoundHandler, setupProcessErrorHandlers } from './middleware/errorHandler';
import { validate, sanitizeInput } from './middleware/validation';
import logger, { httpLogger } from './utils/logger';
import WebSocketServer from './websocket/server';
import authRoutes from './routes/auth';
import messageRoutes from './routes/messages';
import keyExchangeRoutes from './routes/keys';

// Setup process error handlers
setupProcessErrorHandlers();

const app = fastify({
  logger: false, // We'll use our custom logger
  trustProxy: true,
  requestIdHeader: 'x-request-id',
  requestIdLogLabel: 'requestId',
  disableRequestLogging: false,
  bodyLimit: 1048576, // 1MB
  maxParamLength: 500
});

// Register plugins
async function registerPlugins(): Promise<void> {
  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  });

  // CORS
  await app.register(cors, {
    origin: (origin, callback) => {
      const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:8080').split(',');
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset']
  });

  // Compression
  await app.register(compress, {
    global: true,
    threshold: 1024, // Only compress responses larger than 1KB
    encodings: ['gzip', 'deflate']
  });

  // JWT
  await app.register(jwt, {
    secret: process.env.JWT_SECRET || 'change-this-secret',
    sign: {
      algorithm: 'HS256',
      expiresIn: process.env.JWT_ACCESS_TOKEN_EXPIRY || '15m'
    },
    verify: {
      algorithms: ['HS256']
    }
  });

  // Swagger documentation
  await app.register(swagger, {
    swagger: {
      info: {
        title: 'VRCX Messaging API',
        description: 'End-to-end encrypted messaging API for VRCX',
        version: '1.0.0'
      },
      host: process.env.API_HOST || 'localhost:3000',
      schemes: ['https', 'http'],
      consumes: ['application/json'],
      produces: ['application/json'],
      tags: [
        { name: 'auth', description: 'Authentication endpoints' },
        { name: 'messages', description: 'Message operations' },
        { name: 'keys', description: 'Key exchange operations' },
        { name: 'health', description: 'Health check endpoints' }
      ],
      securityDefinitions: {
        Bearer: {
          type: 'apiKey',
          name: 'Authorization',
          in: 'header',
          description: 'JWT Authorization header using the Bearer scheme'
        }
      }
    }
  });

  await app.register(swaggerUi, {
    routePrefix: '/api/v1/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true
    },
    staticCSP: true,
    transformStaticCSP: (header) => header
  });
}

// Setup middleware
app.addHook('onRequest', httpLogger);
app.addHook('onRequest', sanitizeInput('body'));
app.addHook('onRequest', sanitizeInput('query'));

// Global error handler
app.setErrorHandler(errorHandler);
app.setNotFoundHandler(notFoundHandler);

// Health check endpoints
app.get('/api/v1/health', {
  schema: {
    tags: ['health'],
    summary: 'Basic health check',
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          timestamp: { type: 'string' },
          uptime: { type: 'number' },
          environment: { type: 'string' }
        }
      }
    }
  }
}, async (request, reply) => {
  return {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development'
  };
});

app.get('/api/v1/health/detailed', {
  schema: {
    tags: ['health'],
    summary: 'Detailed health check with database status',
    security: [{ Bearer: [] }]
  },
  preHandler: [authenticate, rateLimiters.standard.middleware()]
}, async (request, reply) => {
  const dbHealth = await healthCheck();
  
  return {
    status: dbHealth.postgres && dbHealth.redis ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    services: {
      api: 'healthy',
      database: dbHealth.postgres ? 'healthy' : 'unhealthy',
      cache: dbHealth.redis ? 'healthy' : 'unhealthy',
      websocket: wsServer ? 'healthy' : 'unhealthy'
    },
    details: dbHealth.details,
    version: process.env.API_VERSION || '1.0.0'
  };
});

// Register route modules
app.register(authRoutes, { prefix: '/api/v1/auth' });
app.register(messageRoutes, { prefix: '/api/v1/messages' });
app.register(keyExchangeRoutes, { prefix: '/api/v1/keys' });

let wsServer: WebSocketServer | null = null;

// Start server
const start = async (): Promise<void> => {
  try {
    // Initialize database connections
    logger.info('Initializing database connections...');
    await initializePostgres();
    await initializeRedis();
    await runMigrations();
    logger.info('Database initialization complete');
    
    // Register plugins
    await registerPlugins();
    logger.info('Plugins registered');
    
    const port = parseInt(process.env.PORT || '3000');
    const host = process.env.HOST || '0.0.0.0';
    
    // HTTPS configuration for production
    let httpsOptions = {};
    if (process.env.NODE_ENV === 'production' && process.env.TLS_CERT && process.env.TLS_KEY) {
      httpsOptions = {
        https: {
          cert: readFileSync(path.resolve(process.env.TLS_CERT)),
          key: readFileSync(path.resolve(process.env.TLS_KEY))
        }
      };
      logger.info('HTTPS enabled with TLS certificates');
    }
    
    // Start Fastify server
    await app.listen({ port, host, ...httpsOptions });
    
    const protocol = httpsOptions.https ? 'https' : 'http';
    logger.info(`Server running at ${protocol}://${host}:${port}`);
    logger.info(`API documentation at ${protocol}://${host}:${port}/api/v1/docs`);
    logger.info(`Health check at ${protocol}://${host}:${port}/api/v1/health`);
    
    // Initialize WebSocket server
    const wsPort = parseInt(process.env.WS_PORT || '3001');
    let wsHttpServer;
    
    if (process.env.NODE_ENV === 'production' && process.env.TLS_CERT && process.env.TLS_KEY) {
      wsHttpServer = createServer({
        cert: readFileSync(path.resolve(process.env.TLS_CERT)),
        key: readFileSync(path.resolve(process.env.TLS_KEY))
      });
    } else {
      const http = await import('http');
      wsHttpServer = http.createServer();
    }
    
    wsServer = new WebSocketServer(wsHttpServer);
    
    wsHttpServer.listen(wsPort, () => {
      logger.info(`WebSocket server running on port ${wsPort}`);
    });
    
    // Log server statistics periodically
    setInterval(() => {
      const stats = wsServer?.getStats();
      logger.debug('Server statistics', {
        connections: stats?.totalConnections || 0,
        users: stats?.uniqueUsers || 0,
        memory: process.memoryUsage(),
        uptime: process.uptime()
      });
    }, 60000); // Every minute
    
  } catch (err) {
    logger.error('Failed to start server', { error: err });
    process.exit(1);
  }
};

// Graceful shutdown
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`${signal} received: starting graceful shutdown`);
  
  try {
    // Stop accepting new connections
    await app.close();
    logger.info('HTTP server closed');
    
    // Shutdown WebSocket server
    if (wsServer) {
      await wsServer.shutdown();
      logger.info('WebSocket server closed');
    }
    
    // Close database connections
    await dbShutdown();
    logger.info('Database connections closed');
    
    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error });
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { error });
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', { reason, promise });
});

// Start the server
start().catch((err) => {
  logger.error('Failed to start server', { error: err });
  process.exit(1);
});