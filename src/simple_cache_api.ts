/*
**Test it:**
```bash
# First request - will be slow (cache miss)
curl http://localhost:3000/user/123

# Second request - instant (cache hit)
curl http://localhost:3000/user/123

# Check TTL
curl http://localhost:3000/cache/ttl/123

# Clear cache
curl -X DELETE http://localhost:3000/cache/123
```
*/

import 'dotenv/config';
import express from 'express';
import { Redis } from 'ioredis';

const app = express();

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


// Simulate external API call
async function fetchFromExternalAPI(userId) {
  console.log(`🌐 Fetching user ${userId} from external API...`);
  // Simulate API delay
  await new Promise(resolve => setTimeout(resolve, 2000));
  return {
    id: userId,
    name: `User ${userId}`,
    email: `user${userId}@example.com`,
    timestamp: new Date().toISOString()
  };
}

async function cacheMiddleware(req, res, next) {
  const { userId } = req.params;
  const cacheKey = `user:${userId}`;
  try {
    // Try to get from cache
    const cachedData = await redis.get(cacheKey);
    
    if (cachedData) {
      console.log(`✨ Cache HIT for user ${userId}`);
      return res.json({
        source: 'cache',
        data: JSON.parse(cachedData)
      });
    }

    console.log(`💤 Cache MISS for user ${userId}`);
    
    // Fetch from API
    const apiData = await fetchFromExternalAPI(userId);
    
    // Store in cache with 60 second TTL
    await redis.setex(cacheKey, 60, JSON.stringify(apiData));
    
    res.json({
      source: 'api',
      data: apiData
    });

  } catch (error) {
    console.error('Cache error:', error);
    next(error);
  }
}

// Clear cache endpoint
app.delete('/cache/:userId', async (req, res) => {
  const { userId } = req.params;
  const deleted = await redis.del(`user:${userId}`);
  res.json({ 
    message: deleted ? 'Cache cleared' : 'No cache found',
    deleted: deleted === 1
  });
});

app.get('/cache/ttl/:userId', async (req, res) => {
  const { userId } = req.params;
  const ttl = await redis.ttl(`user:${userId}`);
  res.json({ 
    userId,
    ttl: ttl === -2 ? 'Key does not exist' : 
         ttl === -1 ? 'Key has no expiration' : 
         `${ttl} seconds remaining`
  });
});

// Routes
app.get('/check', (req, res) => {
  res.status(200).send('health check OK');
});

app.get('/user/:userId', cacheMiddleware);


const appPort = 3000;
app.listen(appPort, () => {
    console.info(`Example app listening on port ${appPort}!`);
});