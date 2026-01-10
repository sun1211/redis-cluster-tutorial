/*
**Test it:**
```bash
# Create session
curl -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" \
  -d '{"username":"john_doe","email":"john@example.com"}'

# Get session (use sessionId from above)
curl http://localhost:3000/session/YOUR_SESSION_ID

# Update session
curl -X PATCH http://localhost:3000/session/YOUR_SESSION_ID \
  -H "Content-Type: application/json" \
  -d '{"email":"newemail@example.com"}'

# List all sessions
curl http://localhost:3000/sessions/all

# Logout
curl -X DELETE http://localhost:3000/session/YOUR_SESSION_ID
```
*/
import 'dotenv/config';
import express from 'express';
import { Redis } from 'ioredis';
import crypto from 'crypto'

const SESSION_TTL = 3600; // 1 hour in seconds

const app = express();
app.use(express.json());

const redis = new Redis({
  host: 'localhost',
  port: 6379,
  // Optional: Add reconnection strategy
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
});

// Handle Redis connection events
redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err));

// Generate session ID
function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}


// Routes
app.get('/check', (req, res) => {
  res.status(200).send('health check OK');
});

app.post('/login', async (req, res) => {
  const { username, email } = req.body;
  try {
    const sessionId = generateSessionId();
    const sessionKey = `session:${sessionId}`;
    
    // Store session data as hash
    await redis.hset(sessionKey, {
      username,
      email: email || '',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      loginCount: 1
    });
    
    // Set expiration
    await redis.expire(sessionKey, SESSION_TTL);
    
    res.json({
      success: true,
      sessionId,
      expiresIn: SESSION_TTL
    });
  } catch (error) {
    console.error('Session creation error:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
})

// Get session
app.get('/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const sessionKey = `session:${sessionId}`;

  try {
    // Get all hash fields
    const sessionData = await redis.hgetall(sessionKey);
    
    if (Object.keys(sessionData).length === 0) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    // Update last activity
    await redis.hset(sessionKey, 'lastActivity', Date.now());
    
    // Refresh TTL
    await redis.expire(sessionKey, SESSION_TTL);
    
    // Get remaining TTL
    const ttl = await redis.ttl(sessionKey);

    res.json({
      sessionData,
      ttl: `${ttl} seconds`
    });
  } catch (error) {
    console.error('Session retrieval error:', error);
    res.status(500).json({ error: 'Failed to retrieve session' });
  }
});

// Update session field
app.patch('/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const updates = req.body;
  const sessionKey = `session:${sessionId}`;

  try {
    // Check if session exists
    const exists = await redis.exists(sessionKey);
    if (!exists) {
      return res.status(404).json({ error: 'Session not found' });
    }

    // Update specific fields
    if (Object.keys(updates).length > 0) {
      await redis.hset(sessionKey, updates);
    }
    
    // Increment login count example
    const newCount = await redis.hincrby(sessionKey, 'loginCount', 1);
    
    // Refresh TTL
    await redis.expire(sessionKey, SESSION_TTL);

    res.json({
      success: true,
      loginCount: newCount
    });
  } catch (error) {
    console.error('Session update error:', error);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// Delete session (logout)
app.delete('/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const sessionKey = `session:${sessionId}`;

  try {
    const deleted = await redis.del(sessionKey);
    
    res.json({
      success: deleted === 1,
      message: deleted === 1 ? 'Session deleted' : 'Session not found'
    });
  } catch (error) {
    console.error('Session deletion error:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// List all active sessions (for admin)
app.get('/sessions/all', async (req, res) => {
  try {
    // Scan for all session keys
    const keys = await redis.keys('session:*');
    
    const sessions = await Promise.all(
      keys.map(async (key) => {
        const data = await redis.hgetall(key);
        const ttl = await redis.ttl(key);
        return {
          sessionId: key.replace('session:', ''),
          ...data,
          ttl
        };
      })
    );

    res.json({
      count: sessions.length,
      sessions
    });
  } catch (error) {
    console.error('Sessions list error:', error);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

const appPort = 3000;
app.listen(appPort, () => {
    console.info(`Example app listening on port ${appPort}!`);
});