# VRCX Messaging System - Project Information Hub

## 🚀 Quick Start Guide

### What is this?
An end-to-end encrypted (E2EE) messaging system integrated into VRCX (VRChat Extended), allowing users to send secure async messages through a dedicated "Mailbox" interface.

### Project Status
- **Phase**: MVP Development
- **Architecture**: Client (Electron/Vue.js) + Server (Node.js) + Cloud Services
- **Security**: Signal Protocol E2EE implementation
- **Target Cost**: $5-15/month for cloud hosting

---

## 📁 Project Structure

```
VRCX_Messaging/
├── src/                      # Client-side code (Vue.js components)
│   ├── views/Mailbox/       # Main messaging interface
│   ├── components/          # UI components
│   ├── stores/              # Pinia state management
│   ├── service/             # E2EE & database services
│   └── api/                 # Server communication
├── server/                  # Backend server (Node.js/TypeScript)
│   ├── src/                 # Server source code
│   ├── migrations/          # Database migrations
│   └── tests/               # Server tests
├── SPECS/                   # Documentation
│   ├── design.md           # System design document
│   ├── implementation.md   # Implementation strategy
│   ├── tickets.md          # Development tickets
│   └── info.md            # This file
└── tests/                   # E2E and integration tests
```

---

## 🌐 Cloud Hosting Setup

### Recommended Architecture (MVP - $5-15/month)

#### Primary Stack
- **Server**: Railway.app ($5/month with credits)
  - Node.js/TypeScript API
  - WebSocket server
  - Auto-deploy from GitHub
- **Database**: Neon.tech (Free tier)
  - Serverless PostgreSQL
  - 0.5GB storage free
  - Built-in connection pooling
- **Cache**: Upstash Redis (Free tier)
  - 10k requests/day free
  - Message queues & caching
- **Storage**: Cloudflare R2 (Free tier)
  - 10GB free storage
  - No egress fees

#### Alternative Options
- **Server**: Render.com (free tier) or Fly.io ($3-10/month)
- **Database**: Supabase (500MB free) or PlanetScale (5GB free)
- **Cache**: Redis Cloud (30MB free)

### Environment Variables

```bash
# Server (.env)
NODE_ENV=production
PORT=3000

# Database
DATABASE_URL=postgresql://user:pass@neon.tech/dbname
REDIS_URL=redis://default:pass@upstash.io

# Auth
JWT_SECRET=your-secret-key
JWT_REFRESH_SECRET=your-refresh-secret

# Storage
R2_ACCESS_KEY=cloudflare-access-key
R2_SECRET_KEY=cloudflare-secret-key
R2_BUCKET=vrcx-messages

# Monitoring (optional)
SENTRY_DSN=your-sentry-dsn
```

### Deployment Commands

```bash
# Railway deployment
railway login
railway link
railway up

# Or using GitHub Actions
# Push to main branch triggers auto-deploy

# Database migrations
npm run migrate:up

# Start server
npm start
```

---

## 🔧 Development Setup

### Prerequisites
- Node.js 18+
- npm or yarn
- Git
- SQLite3 (for local development)
- Docker (optional, for local services)

### Local Development

```bash
# Clone and setup
git clone https://github.com/your-org/VRCX_Messaging.git
cd VRCX_Messaging

# Install dependencies
npm install

# Setup local environment
cp .env.example .env
# Edit .env with local settings

# Run database migrations
npm run migrate:dev

# Start development servers
npm run dev:client  # Vue.js client (port 8080)
npm run dev:server  # Node.js server (port 3000)

# Run tests
npm test
npm run test:e2e
```

### Docker Development (Optional)

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

---

## 🧪 Testing Procedures

### Test Coverage Requirements
- Unit Tests: 80% minimum
- Integration Tests: All API endpoints
- E2E Tests: Critical user flows
- Security Tests: Encryption validation

### Running Tests

```bash
# Unit tests
npm run test:unit

# Integration tests
npm run test:integration

# E2E tests (requires running server)
npm run test:e2e

# Security audit
npm audit
npm run security:check

# Performance tests
npm run test:performance
```

### Key Test Scenarios
1. **Encryption Tests**
   - Message encryption/decryption
   - Key exchange protocol
   - Forward secrecy validation

2. **API Tests**
   - Authentication flow
   - Message CRUD operations
   - WebSocket connections

3. **UI Tests**
   - Message sending flow
   - Conversation management
   - Offline functionality

---

## 🔐 Security Implementation

### End-to-End Encryption
- **Protocol**: Signal Protocol (Double Ratchet + X3DH)
- **Library**: libsignal-protocol-javascript
- **Encryption**: AES-256-GCM
- **Key Exchange**: Curve25519
- **Signatures**: Ed25519

### Key Components
```javascript
// E2EE Service location
src/service/e2ee.js

// Key storage
src/service/database/keys.js

// Message encryption flow
1. Generate identity keys on first use
2. Upload public keys to server
3. Exchange keys on first message
4. Encrypt messages client-side
5. Server stores encrypted blob only
```

### Security Checklist
- [ ] All messages encrypted before transmission
- [ ] Keys stored in encrypted SQLite
- [ ] Zero-knowledge server architecture
- [ ] TLS 1.3 for transport security
- [ ] JWT authentication with refresh tokens
- [ ] Rate limiting on all endpoints
- [ ] Input sanitization
- [ ] XSS protection
- [ ] CSRF tokens

---

## 📊 Database Schema

### Client-Side (SQLite)
```sql
-- Local encrypted storage
{userId}_messages
{userId}_conversations  
{userId}_encryption_keys
```

### Server-Side (PostgreSQL)
```sql
-- Encrypted message storage only
messages           -- Encrypted blobs
conversations      -- Metadata only
user_keys         -- Public keys
prekeys           -- One-time keys
```

---

## 🚢 Production Deployment

### Pre-Deployment Checklist
- [ ] All tests passing
- [ ] Security audit completed
- [ ] Performance benchmarks met
- [ ] Documentation updated
- [ ] Rollback plan prepared
- [ ] Monitoring configured

### Deployment Process

```bash
# 1. Run final checks
npm run build
npm run test:all
npm run security:audit

# 2. Deploy to staging
railway environment staging
railway up

# 3. Smoke tests on staging
npm run test:staging

# 4. Deploy to production
railway environment production
railway up

# 5. Monitor deployment
railway logs
# Check monitoring dashboard
```

### Rollback Procedure

```bash
# Quick rollback
railway rollback

# Or manual rollback
git revert HEAD
git push origin main
```

---

## 📈 Monitoring & Metrics

### Key Metrics to Track
- **Performance**
  - Message delivery time (<500ms)
  - API response time (P95 <200ms)
  - WebSocket uptime (>99.9%)

- **Usage**
  - Daily active users
  - Messages sent/received
  - Encryption success rate (>99.99%)

- **Errors**
  - Failed message deliveries
  - Encryption failures
  - API errors

### Monitoring Tools
- **Free Options**
  - Railway/Render built-in metrics
  - Sentry free tier (error tracking)
  - Uptime Robot (availability)

- **Paid Options**
  - Datadog
  - New Relic
  - LogRocket

---

## 🔄 CI/CD Pipeline

### GitHub Actions Workflow

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
      - run: npm ci
      - run: npm test
      - run: npm run build

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - uses: railwayapp/deploy-action@v1
        with:
          service: vrcx-messaging
          token: ${{ secrets.RAILWAY_TOKEN }}
```

---

## 🎯 MVP Requirements

### Core Features (Must Have)
- [x] E2EE messaging
- [x] Message persistence
- [x] Real-time delivery
- [x] Basic UI (send/receive)
- [x] User authentication
- [x] SQLite local storage
- [x] WebSocket support

### Performance Targets
- Support 1000 concurrent users
- <500ms message delivery
- <100ms UI response time
- 99.9% uptime

### Out of Scope (Future)
- Group messaging
- File attachments >25MB
- Voice/video calls
- Multi-device sync
- Advanced search

---

## 👥 Team Resources

### Required Skills
- **Frontend**: Vue.js 2.7, Electron, Pinia
- **Backend**: Node.js, TypeScript, PostgreSQL
- **Security**: Cryptography, Signal Protocol
- **DevOps**: Docker, CI/CD, Cloud platforms

### Documentation
- [Signal Protocol Docs](https://signal.org/docs/)
- [Vue.js 2.7 Guide](https://v2.vuejs.org/)
- [VRCX Repository](https://github.com/vrcx-team/VRCX)
- [Railway Docs](https://docs.railway.app/)
- [Neon Docs](https://neon.tech/docs)

---

## 🐛 Troubleshooting

### Common Issues

#### WebSocket Connection Fails
```bash
# Check server logs
railway logs --service=api

# Verify WebSocket upgrade headers
curl -i -N -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  https://your-api.railway.app/ws
```

#### Encryption Errors
```javascript
// Check key storage
const keys = await database.getKeys(userId);
console.log('Keys exist:', !!keys);

// Validate encryption
const testMessage = "test";
const encrypted = await e2ee.encrypt(testMessage);
const decrypted = await e2ee.decrypt(encrypted);
console.assert(testMessage === decrypted);
```

#### Database Connection Issues
```bash
# Test connection
psql $DATABASE_URL -c "SELECT 1"

# Check migrations
npm run migrate:status
```

---

## 📝 Development Workflow

### Branch Strategy
```
main           → Production
├── staging    → Staging environment
├── develop    → Development
└── feature/*  → Feature branches
```

### Commit Convention
```
feat: Add new feature
fix: Bug fix
docs: Documentation
test: Testing
perf: Performance
security: Security fix
refactor: Code refactoring
```

### Code Review Process
1. Create feature branch
2. Make changes
3. Run tests locally
4. Create pull request
5. Automated CI checks
6. Code review (2 approvals)
7. Merge to develop
8. Deploy to staging
9. QA testing
10. Merge to main

---

## 🆘 Support & Resources

### Getting Help
- **GitHub Issues**: Bug reports and feature requests
- **Discord**: Development discussion
- **Stack Overflow**: Tag with `vrcx-messaging`

### Useful Commands

```bash
# Development
npm run dev           # Start all dev servers
npm run lint          # Run linter
npm run format        # Format code

# Database
npm run db:create     # Create database
npm run db:migrate    # Run migrations
npm run db:seed       # Seed test data
npm run db:reset      # Reset database

# Testing
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report

# Production
npm run build         # Build for production
npm run start         # Start production server
npm run health        # Health check
```

### Environment-Specific Files

```
.env.development     # Local development
.env.staging        # Staging environment
.env.production     # Production environment
.env.test          # Test environment
```

---

## 📅 Release Schedule

### Version Planning
- **v0.1.0** - MVP Alpha (Internal testing)
- **v0.2.0** - MVP Beta (Limited users)
- **v0.3.0** - Public Beta
- **v1.0.0** - Production Release

### Release Checklist
- [ ] Version bump in package.json
- [ ] Update CHANGELOG.md
- [ ] Tag release in Git
- [ ] Deploy to production
- [ ] Announce to users
- [ ] Monitor metrics
- [ ] Gather feedback

---

## 🎉 Quick Commands Reference

```bash
# Setup
git clone [repo] && cd VRCX_Messaging
npm install && npm run setup

# Development
npm run dev

# Testing
npm test

# Deployment
npm run deploy:staging
npm run deploy:production

# Monitoring
npm run logs
npm run metrics
```

---

## 📞 Contact Information

- **Project Lead**: [Contact via GitHub]
- **Security Issues**: security@vrcx-messaging.app
- **General Support**: support@vrcx-messaging.app

---

*Last Updated: 2024*
*Version: 1.0.0*