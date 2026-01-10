# Redis Real-time Leaderboard - Deep Dive

## 📋 **System Overview**

**Type**: Real-time Leaderboard with WebSocket Updates  
**Purpose**: Score tracking, ranking, and real-time updates for competitive systems  
**Architecture Pattern**: Publisher-Subscriber with Sorted Set-based ranking  

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    REAL-TIME LEADERBOARD ARCHITECTURE                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐    REST API    ┌─────────────┐                        │
│  │    HTTP     │────────────────▶│   Express   │                        │
│  │   Clients   │                 │    Server   │                        │
│  │  (Mobile/   │◀───────────────│             │                        │
│  │    Web)     │    JSON        └──────┬──────┘                        │
│  └─────────────┘                       │                                │
│                                        │                                │
│  ┌─────────────┐  WebSocket   ┌───────▼───────┐    Redis Commands      │
│  │   Browser   │──────────────▶│   Socket.io  │───────────────┐        │
│  │   Clients   │◀──────────────│    Server    │               │        │
│  │ (Real-time) │               └───────┬───────┘               │        │
│  └─────────────┘                       │                       │        │
│                                        │                       ▼        │
│                                 ┌──────▼──────┐          ┌─────────────┐│
│                                 │ Leaderboard │          │    Redis    ││
│                                 │    Class    │─────────▶│             ││
│                                 └─────────────┘          │  ┌───────┐  ││
│                                                          │  │Sorted │  ││
│                                                          │  │ Set   │  ││
│                                                          │  └───────┘  ││
│                                                          │  ┌───────┐  ││
│                                                          │  │ Hash  │  ││
│                                                          │  │       │  ││
│                                                          │  └───────┘  ││
│                                                          └─────────────┘│
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## 🔑 **Core Redis Concepts**

### **1. **Sorted Sets (ZSET) - The Heart of Leaderboard**
```
Key: 'game:leaderboard'

Structure:
┌──────────────┬──────────┬────────────┐
│   Member     │  Score   │   Rank     │
├──────────────┼──────────┼────────────┤
│ "player_001" │  1250.0  │     1      │
│ "player_002" │  1100.0  │     2      │
│ "player_003" │   950.0  │     3      │
│ "player_004" │   800.0  │     4      │
└──────────────┴──────────┴────────────┘

Properties:
• Scores are floating-point numbers (64-bit)
• Automatically sorted by score
• O(log(N)) operations for add/update/rank
• Unique members (no duplicate player IDs)
```

### **2. **Hash - Player Metadata**
```
Key Pattern: 'user:stats:{playerId}'

Structure (Hash fields):
┌────────────────┬─────────────────────────┐
│   Field        │        Value           │
├────────────────┼─────────────────────────┤
│ "lastScore"    │ "1250"                 │
│ "lastUpdated"  │ "1704067200000"        │
│ "username"     │ "alice123"             │
│ "country"      │ "US"                   │
│ "level"        │ "42"                   │
└────────────────┴─────────────────────────┘
```

## 🏗️ **System Components**

### **1. Leaderboard Class - Core Logic**
```
Leaderboard Class
├── Constructor
│   └── redis client instance
│
├── updateScore(playerId, score, metadata)
│   ├── ZADD: Add/update in sorted set
│   ├── HSET: Store metadata in hash
│   ├── ZREVRANK: Get rank (descending)
│   └── Return: {playerId, score, rank}
│
├── incrementScore(playerId, increment)
│   ├── ZINCRBY: Atomic increment
│   ├── HSET: Update metadata
│   └── ZREVRANK: Get new rank
│
├── getTopPlayers(limit = 10)
│   ├── ZREVRANGE: Get top N with scores
│   ├── Pipeline: Fetch metadata for each
│   └── Return: Array of ranked players
│
├── getPlayersAroundRank(rank, range = 5)
│   ├── Calculate start/end positions
│   ├── ZREVRANGE: Get slice of leaderboard
│   └── Return: Players with surrounding ranks
│
├── getRank(playerId)
│   └── ZREVRANK: 0-based rank + 1
│
└── getScore(playerId)
    └── ZSCORE: Get player's current score
```

### **2. WebSocket Layer (Socket.io)**
```
Socket.io Event Flow
┌────────────────────────────┬─────────────────────────────────┐
│         Client Event       │         Server Response         │
├────────────────────────────┼─────────────────────────────────┤
│ 'connection'              │ → 'leaderboard:initial'         │
│ (auto on connect)         │   (Send current top 10)         │
│                            │                                 │
│ 'score:submit'            │ → Process & Broadcast:          │
│ {playerId, score, username}│   • 'leaderboard:update'       │
│                            │   • 'score:update' (individual)│
│                            │                                 │
│ 'disconnect'              │ → Log disconnect                │
└────────────────────────────┴─────────────────────────────────┘
```

### **3. REST API Endpoints**
```
HTTP API Endpoints
├── POST /score
│   └── Submit/update score, broadcast via WebSocket
│
├── POST /score/increment
│   └── Increment score (atomic operation)
│
├── GET /leaderboard/top/:limit?
│   └── Get top N players
│
├── GET /player/:playerId
│   └── Get player details + rank + score
│
├── GET /leaderboard/around/:rank
│   └── Get players around specific rank
│
├── GET /leaderboard/stats
│   └── Get total players + top 3
│
└── DELETE /leaderboard
    └── Reset entire leaderboard
```

## 🔄 **Data Flow Architecture**

### **1. Score Update Flow**
```
┌─────────────┐    1. POST /score    ┌─────────────┐    2. ZADD + HSET    ┌─────────────┐
│   Client    │─────────────────────▶│   Express   │─────────────────────▶│    Redis    │
│             │                      │             │                      │             │
│             │◀─────────────────────│             │◀─────────────────────│             │
│             │    6. JSON Response  │             │    3. Updated Data   │             │
└─────────────┘                      └─────────────┘                      └─────────────┘
                                                    │                             │
                                                    │ 4. ZREVRANGE                │
                                                    │ (Get top 10)                │
                                                    │                             │
                                                    │ 5. Broadcast via Socket.io  │
                                                    ▼                             │
                                             ┌─────────────┐                     │
                                             │  Socket.io  │◀────────────────────┘
                                             │   Clients   │
                                             └─────────────┘
```

### **2. Real-time Update Flow**
```
┌─────────────┐                ┌─────────────┐                ┌─────────────┐
│   Browser   │                │   Server    │                │ All Browsers│
│   Client A  │                │ (Socket.io) │                │   (A,B,C)   │
└──────┬──────┘                └──────┬──────┘                └──────┬──────┘
       │                               │                               │
       │ 1. socket.emit('score:submit')│                               │
       │───────────────────────────────▶│                               │
       │                               │                               │
       │                               │ 2. leaderboard.updateScore()  │
       │                               │───────────────────────────────▶│
       │                               │                               │
       │                               │ 3. leaderboard.getTopPlayers()│
       │                               │───────────────────────────────▶│
       │                               │                               │
       │                               │ 4. io.emit('leaderboard:update')│
       │◀──────────────────────────────│───────────────────────────────▶│
       │                               │                               │
       │◀──────────────────────────────│ 5. io.emit('score:update')    │
       │                               │───────────────────────────────▶│
       │                               │                               │
```

## ⚡ **Redis Operations Breakdown**

### **1. Critical Sorted Set Operations**
```javascript
// Atomic Score Update
await redis.zadd(LEADERBOARD_KEY, score, playerId);
// O(log(N)) - maintains sorted order automatically

// Get Rank (0-based, highest score = rank 0)
const rank = await redis.zrevrank(LEADERBOARD_KEY, playerId);
// O(log(N)) - binary search in sorted set

// Get Top N with Scores
const players = await redis.zrevrange(
  LEADERBOARD_KEY,
  0,          // start index (0 = highest score)
  limit - 1,  // end index
  'WITHSCORES' // return scores too
);
// O(log(N) + M) - M = number of returned elements

// Increment Score Atomically
const newScore = await redis.zincrby(LEADERBOARD_KEY, increment, playerId);
// O(log(N)) - thread-safe increment

// Get Players by Score Range
await redis.zrevrangebyscore(
  LEADERBOARD_KEY,
  maxScore,   // max score (inclusive)
  minScore,   // min score (inclusive)
  'WITHSCORES'
);
```

### **2. Pipeline Optimization**
```javascript
// Before optimization (N+1 queries)
for (const player of players) {
  const metadata = await redis.hgetall(`${USER_STATS_KEY}${playerId}`);
}

// After optimization (2 queries)
const pipeline = redis.pipeline();
pipeline.zadd(LEADERBOARD_KEY, score, playerId);          // Query 1
pipeline.hset(`${USER_STATS_KEY}${playerId}`, metadata);  // Query 2
await pipeline.exec();  // Single round-trip
```

## 🎮 **Use Case Examples**

### **1. Gaming Leaderboard**
```
Example: Battle Royale Game
┌──────────────┬────────────┬──────────────┐
│    Player    │   Kills    │    Rank      │
├──────────────┼────────────┼──────────────┤
│ "xXProGamer" │    25      │      #1      │
│ "NoobSlayer" │    22      │      #2      │
│ "CamperKing" │    20      │      #3      │
└──────────────┴────────────┴──────────────┘

Operations:
• ZINCRBY on each kill: +1 score
• Real-time rank updates via WebSocket
• Tournament reset: ZREMRANGEBYRANK
```

### **2. E-commerce Loyalty Points**
```
Example: Customer Rewards
┌──────────────┬────────────┬──────────────┐
│  Customer    │   Points   │    Tier      │
├──────────────┼────────────┼──────────────┤
│ "cust_001"   │  15,000    │    Platinum  │
│ "cust_002"   │  12,500    │     Gold     │
│ "cust_003"   │   8,000    │    Silver    │
└──────────────┴────────────┴──────────────┘

Operations:
• ZADD on purchase: points = price × multiplier
• ZRANGEBYSCORE for tier calculations
• Monthly reset with rollover
```

### **3. Crypto Trading Competition**
```
Example: Trading Volume Leaderboard
┌──────────────┬──────────────┬──────────────┐
│   Trader     │ Volume (BTC) │   ROI (%)    │
├──────────────┼──────────────┼──────────────┤
│ "crypto_whale"│   1,250.5   │    +42.3%    │
│ "day_trader"  │     850.2   │    +28.7%    │
│ "hodl_master" │     420.0   │    +15.2%    │
└──────────────┴──────────────┴──────────────┘

Operations:
• Complex scoring: volume × ROI × risk_factor
• ZUNIONSTORE for combined rankings
• Time-windowed leaderboards
```

## 📊 **Performance Characteristics**

### **1. Operation Complexity**
```
Sorted Set Operations:
┌──────────────────────┬──────────────┬─────────────────────────────┐
│     Operation        │ Complexity   │        Description          │
├──────────────────────┼──────────────┼─────────────────────────────┤
│ ZADD                 │ O(log(N))    │ Add/update score           │
│ ZSCORE               │ O(1)         │ Get score                  │
│ ZREVRANK             │ O(log(N))    │ Get rank (highest first)   │
│ ZREVRANGE            │ O(log(N)+M)  │ Get top M players          │
│ ZINCRBY              │ O(log(N))    │ Atomic increment           │
│ ZCARD                │ O(1)         │ Get total players          │
│ ZREMRANGEBYRANK      │ O(log(N)+M)  │ Remove range               │
└──────────────────────┴──────────────┴─────────────────────────────┘

Where N = total players, M = returned items
```

### **2. Scalability Metrics**
```
Capacity Estimates:
• 1M players: ~64MB memory
• 10M players: ~640MB memory
• Updates: ~10k ops/sec per Redis instance
• Reads: ~50k ops/sec per Redis instance

Memory Calculation:
• Each sorted set entry: ~64 bytes
• Each hash entry: ~50-100 bytes per field
• Total: ~100-150 bytes per player
```

## 🔧 **Advanced Features & Optimizations**

### **1. Time-windowed Leaderboards**
```javascript
// Daily leaderboard
const DAILY_KEY = `leaderboard:daily:${YYYYMMDD}`;

// Weekly leaderboard (aggregated)
const WEEKLY_KEY = `leaderboard:weekly:${YYYYWW}`;
await redis.zunionstore(WEEKLY_KEY, 7, 
  'leaderboard:daily:20240101',
  'leaderboard:daily:20240102',
  // ... 5 more days
);
```

### **2. Multi-dimensional Ranking**
```javascript
// Composite scoring
const compositeScore = (kills * 100) + (damage * 0.1) - (deaths * 50);

// Multiple leaderboards
const KILLS_KEY = 'leaderboard:kills';
const SCORE_KEY = 'leaderboard:score';
const WIN_RATE_KEY = 'leaderboard:winrate';
```

### **3. Pagination Optimization**
```javascript
// Efficient pagination
async function getPage(page, pageSize = 50) {
  const start = (page - 1) * pageSize;
  const end = start + pageSize - 1;
  
  return await redis.zrevrange(
    LEADERBOARD_KEY,
    start,
    end,
    'WITHSCORES'
  );
}
```

## 🛡️ **Security Considerations**

### **1. Input Validation**
```javascript
// Validate score updates
function validateScoreUpdate(playerId, score) {
  // Prevent negative scores
  if (score < 0) throw new Error('Score cannot be negative');
  
  // Rate limiting per player
  const lastUpdate = await redis.get(`rate:${playerId}`);
  if (lastUpdate && Date.now() - lastUpdate < 1000) {
    throw new Error('Rate limit exceeded');
  }
  
  // Score bounds
  if (score > MAX_SCORE_LIMIT) throw new Error('Score exceeds limit');
}
```

### **2. Anti-cheat Measures**
```javascript
// Detect abnormal score jumps
const currentScore = await leaderboard.getScore(playerId);
const scoreIncrease = score - currentScore;

if (scoreIncrease > MAX_ALLOWED_INCREASE) {
  // Flag for review
  await redis.sadd('suspicious:players', playerId);
  
  // Log detailed info
  await redis.hset(`audit:${playerId}:${Date.now()}`, {
    oldScore: currentScore,
    newScore: score,
    increase: scoreIncrease,
    ip: clientIp
  });
}
```

## 📈 **Monitoring & Analytics**

### **1. Leaderboard Metrics**
```javascript
// Track leaderboard health
const metrics = {
  totalPlayers: await redis.zcard(LEADERBOARD_KEY),
  updateFrequency: await redis.get('metrics:updates:per_minute'),
  topScore: await redis.zrevrange(LEADERBOARD_KEY, 0, 0, 'WITHSCORES'),
  scoreDistribution: await getScoreDistribution(),
  activePlayers: await redis.scard('active:players')
};
```

### **2. Real-time Analytics Dashboard**
```javascript
// WebSocket analytics stream
io.of('/analytics').on('connection', (socket) => {
  // Stream leaderboard changes
  const stream = redis.scanStream({ match: 'leaderboard:*' });
  stream.on('data', (keys) => {
    socket.emit('analytics:update', {
      timestamp: Date.now(),
      leaderboards: keys.length,
      // ... more metrics
    });
  });
});
```

## 🚀 **Production Deployment**

### **1. Redis Configuration**
```bash
# redis.conf optimizations for leaderboards
maxmemory 2gb
maxmemory-policy allkeys-lfu
zset-max-ziplist-entries 128
zset-max-ziplist-value 64
activerehashing yes
```

### **2. High Availability Setup**
```
Primary-Secondary Replication:
┌─────────────┐    Async Replication    ┌─────────────┐
│   Primary   │────────────────────────▶│  Secondary  │
│   Redis     │                         │    Redis    │
│ (Master)    │◀────────────────────────│   (Slave)   │
└─────────────┘                         └─────────────┘
       │                                       │
       │ Write Operations                      │ Read Operations
       ▼                                       ▼
┌─────────────┐                         ┌─────────────┐
│   Express   │                         │   Express   │
│    App      │                         │    App      │
└─────────────┘                         └─────────────┘
```

### **3. Load Testing Scenarios**
```javascript
// Simulate concurrent updates
const simulateLoad = async (concurrentUsers = 1000, updatesPerUser = 10) => {
  for (let i = 0; i < concurrentUsers; i++) {
    setTimeout(async () => {
      for (let j = 0; j < updatesPerUser; j++) {
        await leaderboard.incrementScore(`user_${i}`, Math.random() * 100);
        await sleep(Math.random() * 100); // Random delay
      }
    }, Math.random() * 1000); // Stagger start
  }
};
```

This leaderboard system demonstrates how Redis Sorted Sets provide a perfect data structure for real-time rankings, combining O(log(N)) performance with automatic sorting and rich query capabilities. The WebSocket layer adds real-time updates, making it suitable for gaming, competitions, and any scenario requiring live leaderboards.