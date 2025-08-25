# VRCX Async Messaging System Design Document

## 1. Executive Summary

This document outlines the design for implementing an end-to-end encrypted async messaging system within VRCX. The system will allow users to send and receive messages through a dedicated "Mailbox" tab, utilizing the existing VRCX infrastructure while maintaining complete message privacy through end-to-end encryption.

## 2. System Architecture Overview

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     VRCX Desktop Client                      │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Vue.js Frontend (Electron)              │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │   │
│  │  │Navigation│  │ Mailbox  │  │  Message Store   │  │   │
│  │  │   Menu   │──│   View   │──│    (Pinia)       │  │   │
│  │  └──────────┘  └──────────┘  └──────────────────┘  │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                 Security Layer                       │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │   │
│  │  │  E2EE    │  │   Key    │  │  Cryptographic  │  │   │
│  │  │  Module  │  │ Manager  │  │    Operations   │  │   │
│  │  └──────────┘  └──────────┘  └──────────────────┘  │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Local Storage (SQLite)                  │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   WebSocket/HTTPS  │
                    └─────────┬─────────┘
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                    Message Relay Server                     │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  API Gateway                         │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │   │
│  │  │   Auth   │  │  Rate    │  │   WebSocket     │  │   │
│  │  │  Service │  │ Limiting │  │    Handler      │  │   │
│  │  └──────────┘  └──────────┘  └──────────────────┘  │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Message Processing Layer                │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │   │
│  │  │  Queue   │  │ Message  │  │  Notification   │  │   │
│  │  │  Manager │  │  Router  │  │    Service      │  │   │
│  │  └──────────┘  └──────────┘  └──────────────────┘  │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │           Encrypted Message Storage                  │   │
│  │         (PostgreSQL/MongoDB + Redis Cache)           │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Component Breakdown

#### Frontend Components
- **Mailbox View** (`src/views/Mailbox/Mailbox.vue`): Main messaging interface
- **Message Composer** (`src/components/MessageComposer.vue`): Message creation UI
- **Message Thread** (`src/components/MessageThread.vue`): Conversation display
- **Message List** (`src/components/MessageList.vue`): Inbox/sent/archived views
- **Encryption Status** (`src/components/EncryptionStatus.vue`): Security indicators

#### Backend Services
- **Message Store** (`src/stores/messaging.js`): Pinia store for message state
- **Encryption Service** (`src/service/e2ee.js`): End-to-end encryption logic
- **Message API** (`src/api/messaging.js`): Server communication layer
- **Message Database** (`src/service/database/messages.js`): Local message storage

## 3. Security Architecture

### 3.1 End-to-End Encryption Design

#### Encryption Protocol: Signal Protocol Implementation
- **Double Ratchet Algorithm**: Forward secrecy and break-in recovery
- **X3DH Key Agreement**: Initial key exchange
- **AES-256-GCM**: Message encryption
- **Ed25519**: Digital signatures
- **Curve25519**: Key exchange

#### Key Management
```javascript
// Key Hierarchy
{
  identityKeyPair: {
    publicKey: Curve25519PublicKey,
    privateKey: Curve25519PrivateKey
  },
  signedPreKey: {
    keyId: number,
    publicKey: Curve25519PublicKey,
    privateKey: Curve25519PrivateKey,
    signature: Ed25519Signature
  },
  oneTimePreKeys: [{
    keyId: number,
    publicKey: Curve25519PublicKey,
    privateKey: Curve25519PrivateKey
  }]
}
```

### 3.2 Security Measures

#### Client-Side Security
- **Key Storage**: Encrypted local storage using device-specific keys
- **Memory Protection**: Clear sensitive data from memory after use
- **Input Validation**: Sanitize all user inputs
- **Content Security Policy**: Strict CSP headers for Electron app

#### Server-Side Security
- **Zero-Knowledge Architecture**: Server cannot decrypt messages
- **Authentication**: JWT tokens with refresh mechanism
- **Rate Limiting**: Prevent spam and DoS attacks
- **Message Metadata**: Minimal metadata storage (only routing info)

#### Transport Security
- **TLS 1.3**: All communications encrypted in transit
- **Certificate Pinning**: Prevent MITM attacks
- **WebSocket Security**: Secure WebSocket (WSS) for real-time updates

## 4. Data Models

### 4.1 Local Database Schema

```sql
-- Messages table
CREATE TABLE {userId}_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    recipient_id TEXT NOT NULL,
    encrypted_content BLOB NOT NULL,
    encryption_metadata TEXT,
    timestamp INTEGER NOT NULL,
    read_status INTEGER DEFAULT 0,
    delivery_status TEXT,
    message_type TEXT DEFAULT 'text',
    attachments TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    INDEX idx_conversation (conversation_id),
    INDEX idx_timestamp (timestamp)
);

-- Conversations table
CREATE TABLE {userId}_conversations (
    id TEXT PRIMARY KEY,
    participant_id TEXT NOT NULL,
    participant_name TEXT,
    participant_avatar TEXT,
    last_message_id TEXT,
    last_message_time INTEGER,
    unread_count INTEGER DEFAULT 0,
    is_archived INTEGER DEFAULT 0,
    is_muted INTEGER DEFAULT 0,
    encryption_session TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now')),
    INDEX idx_updated (updated_at)
);

-- Encryption keys table
CREATE TABLE {userId}_encryption_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    key_type TEXT NOT NULL,
    public_key TEXT NOT NULL,
    private_key_encrypted BLOB,
    key_metadata TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    expires_at INTEGER,
    UNIQUE(user_id, key_type)
);
```

### 4.2 Server Message Format

```typescript
interface EncryptedMessage {
  id: string;
  senderId: string;
  recipientId: string;
  encryptedContent: string; // Base64 encoded
  encryptionType: 'signal' | 'fallback';
  ephemeralPublicKey?: string;
  nonce: string;
  timestamp: number;
  ttl?: number; // Time to live for ephemeral messages
}
```

## 5. User Interface Design

### 5.1 Navigation Integration

Add "Mailbox" to the existing navigation menu:
```javascript
// In NavMenu.vue
menuItems.push({
    index: 'mailbox',
    icon: 'el-icon-message',
    tooltip: 'Mailbox',
    notificationKey: 'unreadMessages'
});
```

### 5.2 Mailbox Layout

```
┌────────────────────────────────────────────────────────┐
│  Mailbox                                    [Compose]  │
├────────────────┬───────────────────────────────────────┤
│                │  Conversation with: DisplayName       │
│  Inbox (12)    │ ┌───────────────────────────────────┐ │
│  Sent          │ │  Their message...                 │ │
│  Archived      │ │                          12:34 PM │ │
│                │ └───────────────────────────────────┘ │
│ ─────────────  │ ┌───────────────────────────────────┐ │
│                │ │                     Your message  │ │
│ Friend1    (3) │ │  12:35 PM                        │ │
│ Friend2    (1) │ └───────────────────────────────────┘ │
│ Friend3        │ ┌───────────────────────────────────┐ │
│ Friend4        │ │  Type a message...               │ │
│                │ │                         [Send]    │ │
│                │ └───────────────────────────────────┘ │
└────────────────┴───────────────────────────────────────┘
```

### 5.3 UI Components

#### Message Composer Features
- Rich text editor with markdown support
- File attachment support (images, documents)
- Emoji picker integration
- Typing indicators
- Read receipts
- Message reactions

#### Security Indicators
- Encryption status badge
- Key verification UI
- Security warnings for unverified keys
- Encrypted attachment indicators

## 6. API Design

### 6.1 Client API Endpoints

```typescript
// Message Operations
POST   /api/v1/messages/send
GET    /api/v1/messages/conversations
GET    /api/v1/messages/conversation/{conversationId}
DELETE /api/v1/messages/{messageId}
PUT    /api/v1/messages/{messageId}/read

// Key Exchange
POST   /api/v1/keys/upload
GET    /api/v1/keys/{userId}/bundle
POST   /api/v1/keys/rotate

// Real-time
WS     /api/v1/messages/stream
```

### 6.2 WebSocket Events

```typescript
// Client -> Server
interface ClientEvents {
  'message:send': EncryptedMessage;
  'message:typing': { conversationId: string };
  'message:read': { messageId: string };
  'presence:update': { status: 'online' | 'offline' };
}

// Server -> Client
interface ServerEvents {
  'message:received': EncryptedMessage;
  'message:delivered': { messageId: string };
  'message:read': { messageId: string, readBy: string };
  'typing:start': { userId: string, conversationId: string };
  'typing:stop': { userId: string, conversationId: string };
}
```

## 7. Implementation Roadmap

### Phase 1: Foundation (Week 1-2)
- [ ] Setup server infrastructure
- [ ] Implement basic E2EE library integration
- [ ] Create database schemas
- [ ] Setup API endpoints

### Phase 2: Core Messaging (Week 3-4)
- [ ] Implement Mailbox UI component
- [ ] Create message composer
- [ ] Implement message send/receive flow
- [ ] Add local message storage

### Phase 3: Security Features (Week 5-6)
- [ ] Complete E2EE implementation
- [ ] Add key verification UI
- [ ] Implement secure key storage
- [ ] Add security audit logging

### Phase 4: Enhanced Features (Week 7-8)
- [ ] Add file attachments
- [ ] Implement typing indicators
- [ ] Add read receipts
- [ ] Create message search

### Phase 5: Testing & Polish (Week 9-10)
- [ ] Security audit
- [ ] Performance optimization
- [ ] User testing
- [ ] Documentation

## 8. Technology Stack

### Frontend
- **Framework**: Vue.js 2.7.16 (existing)
- **UI Library**: Element UI (existing)
- **State Management**: Pinia (existing)
- **Encryption**: libsignal-protocol-javascript
- **Database**: SQLite (existing)

### Backend Server
- **Runtime**: Node.js with TypeScript
- **Framework**: Fastify or Express
- **Database**: PostgreSQL with Redis cache
- **Queue**: Bull (Redis-based)
- **WebSocket**: Socket.io or native WebSocket
- **Authentication**: JWT with refresh tokens

### Security Libraries
- **E2EE**: Signal Protocol (libsignal)
- **Crypto**: Node.js crypto module + sodium-native
- **Key Derivation**: Argon2
- **Random**: crypto.getRandomValues()

## 9. Security Considerations

### 9.1 Threat Model

#### Threats Addressed
- **Message Interception**: E2EE prevents reading by third parties
- **Server Compromise**: Zero-knowledge architecture
- **MITM Attacks**: Certificate pinning and key verification
- **Replay Attacks**: Nonces and timestamps
- **Metadata Analysis**: Minimal metadata storage

#### Threats Partially Addressed
- **Client Compromise**: Limited by local security measures
- **Social Engineering**: User education required
- **Traffic Analysis**: Consider adding padding/timing obfuscation

### 9.2 Security Best Practices

1. **Regular Security Audits**: Quarterly penetration testing
2. **Dependency Management**: Automated vulnerability scanning
3. **Incident Response Plan**: Documented procedures
4. **Privacy Policy**: Clear data handling documentation
5. **User Education**: Security best practices guide

## 10. Performance Considerations

### 10.1 Client Optimization
- **Message Pagination**: Load messages in chunks
- **Lazy Loading**: Load conversations on demand
- **IndexedDB**: Consider for larger message storage
- **Virtual Scrolling**: For long message lists
- **Debounced Search**: Optimize message search

### 10.2 Server Optimization
- **Message Queue**: Async processing with Redis/Bull
- **Database Indexing**: Optimize query performance
- **Caching Strategy**: Redis for hot data
- **CDN**: Static assets and attachments
- **Rate Limiting**: Prevent abuse

## 11. Testing Strategy

### 11.1 Test Coverage Requirements
- **Unit Tests**: 80% code coverage minimum
- **Integration Tests**: API endpoint testing
- **E2E Tests**: Critical user flows
- **Security Tests**: Penetration testing
- **Performance Tests**: Load and stress testing

### 11.2 Test Scenarios
- Message encryption/decryption
- Key exchange protocols
- Offline message queuing
- Large file attachments
- Concurrent message sending
- Network failure recovery

## 12. Monitoring & Analytics

### 12.1 Metrics to Track
- **Performance**: Message delivery time, encryption overhead
- **Reliability**: Message delivery rate, error rates
- **Security**: Failed auth attempts, encryption errors
- **Usage**: Active users, messages per day
- **User Experience**: UI response times, search performance

### 12.2 Privacy-Preserving Analytics
- No message content logging
- Aggregate metrics only
- User opt-in for analytics
- Local-only performance metrics
- Anonymized error reporting

## 13. Compliance & Legal

### 13.1 Data Protection
- **GDPR Compliance**: User data rights
- **CCPA Compliance**: California privacy rights
- **Data Retention**: Configurable retention policies
- **Right to Delete**: Complete data removal
- **Data Portability**: Export user messages

### 13.2 Terms of Service Updates
- Messaging service terms
- Encryption disclaimers
- Data handling policies
- Liability limitations
- User responsibilities

## 14. Future Enhancements

### Potential Features
- **Group Messaging**: Encrypted group chats
- **Voice Messages**: Encrypted audio messages
- **Video Calls**: P2P encrypted video
- **Message Reactions**: Emoji reactions
- **Threading**: Reply to specific messages
- **Search**: Encrypted search capabilities
- **Backup**: Encrypted cloud backup
- **Multi-Device**: Message sync across devices

## 15. Conclusion

This design provides a robust, secure, and user-friendly messaging system that integrates seamlessly with VRCX while maintaining the highest standards of privacy through end-to-end encryption. The phased implementation approach allows for iterative development and testing while ensuring core security features are implemented from the beginning.

The system leverages existing VRCX infrastructure where possible while introducing new components specifically designed for secure messaging. By following this design, we can deliver a messaging system that users can trust with their private communications.