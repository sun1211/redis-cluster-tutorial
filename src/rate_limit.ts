/*
**Test it:**
```bash
# Test sliding window (run multiple times quickly)
for i in {1..15}; do 
  curl -w "\n" http://localhost:3000/api/sliding-window
  sleep 0.5
done

# Check status
curl http://localhost:3000/api/status/::1

# Reset rate limit
curl -X DELETE http://localhost:3000/api/reset/::1
```
*/
import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { Redis } from 'ioredis';

// Rate limit configuration
const RATE_LIMIT_CONFIG = {
  maxRequests: 10,      // Maximum requests
  windowSeconds: 60     // Time window in seconds
};

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

// Routes
app.get('/check', (req, res) => {
  res.status(200).send('health check OK');
});

/**
 * Sliding window rate limiter using sorted sets
 * More accurate than fixed window
 */
async function slidingWindowRateLimiter(identifier) {
  const key = `rate_limit:${identifier}`;
  const now = Date.now();
  const windowStart = now - (RATE_LIMIT_CONFIG.windowSeconds * 1000);

  try {
    // Use pipeline for atomic operations
    const pipeline = redis.pipeline();
    
    // Remove old entries outside the window
    pipeline.zremrangebyscore(key, 0, windowStart);
    
    // Count current requests in window
    pipeline.zcard(key);
    
    // Add current request with timestamp as score
    pipeline.zadd(key, now, `${now}-${Math.random()}`);
    
    // Set expiration on the key
    pipeline.expire(key, RATE_LIMIT_CONFIG.windowSeconds);
    
    const results = await pipeline.exec();
    // results structure: Array of [error, value] pairs for each command:
    // results[0][1]: Result from zremrangebyscore
    // results[1][1]: Result from zcard → currentCount
    // results[2][1]: Result from zadd
    // results[3][1]: Result from expire
    const currentCount = results[1][1];
    
    const allowed = Number(currentCount) < RATE_LIMIT_CONFIG.maxRequests;
    const remaining = Math.max(0, RATE_LIMIT_CONFIG.maxRequests - Number(currentCount) - 1);
    
    // Get oldest request timestamp for reset time
    const oldestRequest = await redis.zrange(key, 0, 0, 'WITHSCORES') as string[];
    const resetTime = oldestRequest.length > 0
      ? parseInt(oldestRequest[1]) + (RATE_LIMIT_CONFIG.windowSeconds * 1000)
      : now + (RATE_LIMIT_CONFIG.windowSeconds * 1000);

    return {
      allowed,
      limit: RATE_LIMIT_CONFIG.maxRequests,
      remaining,
      resetAt: new Date(resetTime).toISOString(),
      retryAfter: Math.ceil((resetTime - now) / 1000)
    };
  } catch (error) {
    console.error('Rate limiter error:', error);
    // Fail open - allow request if Redis is down
    return { allowed: true, error: 'Rate limiter unavailable' };
  }
}

/**
 * Simple token bucket rate limiter using INCR
 * Simpler but uses fixed windows
 */
async function tokenBucketRateLimiter(identifier) {
  const key = `rate_limit_simple:${identifier}`;
  
  try {
    // Multi/exec for atomic operations
    const multi = redis.multi();
    multi.incr(key);
    multi.expire(key, RATE_LIMIT_CONFIG.windowSeconds);
    
    const results = await multi.exec();
    const currentCount = results[0][1];
    
    const allowed = Number(currentCount) <= RATE_LIMIT_CONFIG.maxRequests;
    const remaining = Math.max(0, RATE_LIMIT_CONFIG.maxRequests - Number(currentCount));
    
    const ttl = await redis.ttl(key);
    
    return {
      allowed,
      limit: RATE_LIMIT_CONFIG.maxRequests,
      remaining,
      resetIn: ttl,
      retryAfter: ttl
    };
  } catch (error) {
    console.error('Rate limiter error:', error);
    return { allowed: true, error: 'Rate limiter unavailable' };
  }
}

// Rate limiting middleware
function rateLimitMiddleware(limiterType = 'sliding') {
  return async (req, res, next) => {
    // Use IP address as identifier (in production, use user ID or API key)
    const identifier = req.ip || req.socket.remoteAddress;
    
    const limiter = limiterType === 'sliding' 
      ? slidingWindowRateLimiter 
      : tokenBucketRateLimiter;
    
    const result: any = await limiter(identifier);
    
    // Add rate limit headers
    const resetAt = result?.resetAt || new Date(Date.now() + ((result.resetIn || 0) * 1000)).toISOString();
    res.set({
      'X-RateLimit-Limit': result.limit,
      'X-RateLimit-Remaining': result.remaining,
      'X-RateLimit-Reset': resetAt
    });
    
    if (!result.allowed) {
      res.set('Retry-After', result.retryAfter);
      return res.status(429).json({
        error: 'Too many requests',
        message: `Rate limit exceeded. Try again in ${result.retryAfter} seconds`,
        limit: result.limit,
        retryAfter: result.retryAfter
      });
    }
    
    next();
  };
}

// Protected routes
app.get('/api/sliding-window', rateLimitMiddleware('sliding'), (req, res) => {
  res.json({
    message: 'Success! (Sliding window rate limiting)',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/token-bucket', rateLimitMiddleware('token'), (req, res) => {
  res.json({
    message: 'Success! (Token bucket rate limiting)',
    timestamp: new Date().toISOString()
  });
});

// Check current rate limit status
app.get('/api/status/:ip', async (req, res) => {
  const { ip } = req.params;
  
  const slidingKey = `rate_limit:${ip}`;
  const tokenKey = `rate_limit_simple:${ip}`;
  
  const [slidingCount, tokenCount, slidingTtl, tokenTtl] = await Promise.all([
    redis.zcard(slidingKey),
    redis.get(tokenKey),
    redis.ttl(slidingKey),
    redis.ttl(tokenKey)
  ]);

  res.json({
    ip,
    slidingWindow: {
      requests: slidingCount,
      remaining: Math.max(0, RATE_LIMIT_CONFIG.maxRequests - slidingCount),
      ttl: slidingTtl
    },
    tokenBucket: {
      requests: parseInt(tokenCount) || 0,
      remaining: Math.max(0, RATE_LIMIT_CONFIG.maxRequests - (parseInt(tokenCount) || 0)),
      ttl: tokenTtl
    }
  });
});

// Reset rate limit for testing
app.delete('/api/reset/:ip', async (req, res) => {
  const { ip } = req.params;
  
  await redis.del(`rate_limit:${ip}`, `rate_limit_simple:${ip}`);
  
  res.json({ message: 'Rate limit reset', ip });
});

const appPort = 3000;
app.listen(appPort, () => {
    console.info(`Example app listening on port ${appPort}!`);
});