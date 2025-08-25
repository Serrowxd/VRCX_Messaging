import fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import dotenv from 'dotenv';
import { Server } from 'socket.io';
import { createServer } from 'http';

// Load environment variables
dotenv.config();

const app = fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    prettyPrint: process.env.NODE_ENV === 'development'
  }
});

// Register plugins
async function registerPlugins(): Promise<void> {
  // CORS
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN || 'http://localhost:8080',
    credentials: true
  });

  // JWT
  await app.register(jwt, {
    secret: process.env.JWT_SECRET || 'change-this-secret',
    sign: {
      expiresIn: process.env.JWT_ACCESS_TOKEN_EXPIRY || '15m'
    }
  });

  // Rate limiting
  await app.register(rateLimit, {
    max: parseInt(process.env.RATE_LIMIT_MAX || '100'),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60000')
  });
}

// Health check endpoint
app.get('/api/v1/health', async (request, reply) => {
  return {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV
  };
});

// Start server
const start = async (): Promise<void> => {
  try {
    await registerPlugins();
    
    const port = parseInt(process.env.PORT || '3000');
    const host = process.env.HOST || '0.0.0.0';
    
    await app.listen({ port, host });
    
    app.log.info(`Server running at http://${host}:${port}`);
    app.log.info(`Health check available at http://${host}:${port}/api/v1/health`);
    
    // Initialize WebSocket server
    const httpServer = createServer();
    const io = new Server(httpServer, {
      cors: {
        origin: process.env.WS_CORS_ORIGIN || 'http://localhost:8080',
        credentials: true
      }
    });
    
    const wsPort = parseInt(process.env.WS_PORT || '3001');
    httpServer.listen(wsPort, () => {
      app.log.info(`WebSocket server running on port ${wsPort}`);
    });
    
    // Basic WebSocket connection handler
    io.on('connection', (socket) => {
      app.log.info(`Client connected: ${socket.id}`);
      
      socket.on('disconnect', () => {
        app.log.info(`Client disconnected: ${socket.id}`);
      });
    });
    
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

// Handle shutdown gracefully
process.on('SIGINT', async () => {
  app.log.info('SIGINT signal received: closing HTTP server');
  await app.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  app.log.info('SIGTERM signal received: closing HTTP server');
  await app.close();
  process.exit(0);
});

// Start the server
start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});