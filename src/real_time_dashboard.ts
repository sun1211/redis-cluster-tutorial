/*
**Real-time Leaderboard with Redis Sorted Sets and Socket.io**

**Test it:**
```bash
# Start the server
npm run dev src/real_time_dashboard.ts
# or
ts-node src/real_time_dashboard.ts

# Open in browser
open http://localhost:3004

# Or test with curl
curl -X POST http://localhost:3004/score \
  -H "Content-Type: application/json" \
  -d '{"playerId":"player1","username":"Alice","score":1000}'

curl -X POST http://localhost:3004/score \
  -H "Content-Type: application/json" \
  -d '{"playerId":"player2","username":"Bob","score":950}'

# Get top players
curl http://localhost:3004/leaderboard/top/10

# Get specific player
curl http://localhost:3004/player/player1

# Get stats
curl http://localhost:3004/leaderboard/stats

# Reset leaderboard
curl -X DELETE http://localhost:3004/leaderboard
```
*/

import 'dotenv/config';
import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { Redis } from 'ioredis';

const app = express();
const server = createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' }
});

app.use(express.json());
app.use(express.static('public'));

const redis = new Redis({
  host: 'localhost',
  port: 6379
});

redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err));

const LEADERBOARD_KEY = 'game:leaderboard';
const USER_STATS_KEY = 'user:stats:';

interface PlayerMetadata {
  username?: string;
  lastScore?: number | string;
  lastUpdated?: number | string;
  [key: string]: any;
}

interface PlayerResult {
  playerId: string;
  score: number;
  rank: number | null;
}

interface LeaderboardPlayer extends PlayerMetadata {
  rank: number;
  playerId: string;
  score: number;
}

interface ScoreSubmitData {
  playerId: string;
  score: number;
  username?: string;
}

class Leaderboard {
  private redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  /**
   * Add or update player score
   */
  async updateScore(playerId: string, score: number, metadata: PlayerMetadata = {}): Promise<PlayerResult> {
    const pipeline = this.redis.pipeline();

    // Add to sorted set (score is the sort key)
    pipeline.zadd(LEADERBOARD_KEY, score, playerId);

    // Store player metadata
    pipeline.hset(`${USER_STATS_KEY}${playerId}`, {
      lastScore: score.toString(),
      lastUpdated: Date.now().toString(),
      ...metadata
    });

    await pipeline.exec();

    // Get player's rank
    const rank = await this.getRank(playerId);

    return { playerId, score, rank };
  }

  /**
   * Increment player score
   */
  async incrementScore(playerId: string, increment: number): Promise<PlayerResult> {
    const newScore = await this.redis.zincrby(LEADERBOARD_KEY, increment, playerId);

    await this.redis.hset(`${USER_STATS_KEY}${playerId}`, {
      lastScore: newScore,
      lastUpdated: Date.now().toString()
    });

    const rank = await this.getRank(playerId);

    return { playerId, score: parseFloat(newScore), rank };
  }

  /**
   * Get player's rank (1-based)
   */
  async getRank(playerId: string): Promise<number | null> {
    // ZREVRANK returns rank in descending order (highest score = rank 0)
    const rank = await this.redis.zrevrank(LEADERBOARD_KEY, playerId);
    return rank !== null ? rank + 1 : null; // Convert to 1-based
  }

  /**
   * Get player's score
   */
  async getScore(playerId: string): Promise<number | null> {
    const score = await this.redis.zscore(LEADERBOARD_KEY, playerId);
    return score !== null ? parseFloat(score) : null;
  }

  /**
   * Get top N players
   */
  async getTopPlayers(limit: number = 10): Promise<LeaderboardPlayer[]> {
    // ZREVRANGE returns in descending order with scores
    const players = await this.redis.zrevrange(
      LEADERBOARD_KEY,
      0,
      limit - 1,
      'WITHSCORES'
    );

    const result: LeaderboardPlayer[] = [];
    for (let i = 0; i < players.length; i += 2) {
      const playerId = players[i];
      const score = parseFloat(players[i + 1]);
      const metadata = await this.redis.hgetall(`${USER_STATS_KEY}${playerId}`);

      result.push({
        rank: Math.floor(i / 2) + 1,
        playerId,
        score,
        ...metadata
      });
    }

    return result;
  }

  /**
   * Get players around a specific rank
   */
  async getPlayersAroundRank(rank: number, range: number = 5): Promise<LeaderboardPlayer[]> {
    const start = Math.max(0, rank - range - 1);
    const end = rank + range - 1;

    const players = await this.redis.zrevrange(
      LEADERBOARD_KEY,
      start,
      end,
      'WITHSCORES'
    );

    const result: LeaderboardPlayer[] = [];
    for (let i = 0; i < players.length; i += 2) {
      const playerId = players[i];
      const score = parseFloat(players[i + 1]);
      const metadata = await this.redis.hgetall(`${USER_STATS_KEY}${playerId}`);

      result.push({
        rank: start + Math.floor(i / 2) + 1,
        playerId,
        score,
        ...metadata
      });
    }

    return result;
  }

  /**
   * Get players within score range
   */
  async getPlayersByScoreRange(minScore: number, maxScore: number): Promise<Array<{ playerId: string; score: number }>> {
    const players = await this.redis.zrevrangebyscore(
      LEADERBOARD_KEY,
      maxScore,
      minScore,
      'WITHSCORES'
    );

    const result: Array<{ playerId: string; score: number }> = [];
    for (let i = 0; i < players.length; i += 2) {
      result.push({
        playerId: players[i],
        score: parseFloat(players[i + 1])
      });
    }

    return result;
  }

  /**
   * Get total number of players
   */
  async getPlayerCount(): Promise<number> {
    return await this.redis.zcard(LEADERBOARD_KEY);
  }

  /**
   * Remove player from leaderboard
   */
  async removePlayer(playerId: string): Promise<void> {
    await this.redis.zrem(LEADERBOARD_KEY, playerId);
    await this.redis.del(`${USER_STATS_KEY}${playerId}`);
  }

  /**
   * Reset entire leaderboard
   */
  async reset(): Promise<void> {
    const players = await this.redis.zrange(LEADERBOARD_KEY, 0, -1);

    const pipeline = this.redis.pipeline();
    pipeline.del(LEADERBOARD_KEY);

    players.forEach(playerId => {
      pipeline.del(`${USER_STATS_KEY}${playerId}`);
    });

    await pipeline.exec();
  }
}

const leaderboard = new Leaderboard(redis);

// === REST API ENDPOINTS ===

// Update player score
app.post('/score', async (req: Request, res: Response) => {
  try {
    const { playerId, score, username } = req.body;

    if (!playerId || score === undefined) {
      return res.status(400).json({ error: 'playerId and score required' });
    }

    const result = await leaderboard.updateScore(playerId, score, { username });

    // Broadcast update to all connected clients
    const topPlayers = await leaderboard.getTopPlayers(10);
    io.emit('leaderboard:update', topPlayers);
    io.emit('score:update', result);

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Increment player score
app.post('/score/increment', async (req: Request, res: Response) => {
  try {
    const { playerId, increment } = req.body;

    const result = await leaderboard.incrementScore(playerId, increment);

    // Broadcast update
    const topPlayers = await leaderboard.getTopPlayers(10);
    io.emit('leaderboard:update', topPlayers);

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get top players
app.get('/leaderboard/top/:limit?', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.params.limit || '10') || 10;
    const players = await leaderboard.getTopPlayers(limit);
    res.json(players);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get player info
app.get('/player/:playerId', async (req: Request, res: Response) => {
  try {
    const { playerId } = req.params;

    const [score, rank, metadata] = await Promise.all([
      leaderboard.getScore(playerId),
      leaderboard.getRank(playerId),
      redis.hgetall(`${USER_STATS_KEY}${playerId}`)
    ]);

    if (score === null) {
      return res.status(404).json({ error: 'Player not found' });
    }

    res.json({
      playerId,
      score,
      rank,
      ...metadata
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get players around rank
app.get('/leaderboard/around/:rank', async (req: Request, res: Response) => {
  try {
    const rank = parseInt(req.params.rank);
    const range = parseInt(req.query.range as string) || 5;

    const players = await leaderboard.getPlayersAroundRank(rank, range);
    res.json(players);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get stats
app.get('/leaderboard/stats', async (req: Request, res: Response) => {
  try {
    const totalPlayers = await leaderboard.getPlayerCount();
    const topPlayers = await leaderboard.getTopPlayers(3);

    res.json({
      totalPlayers,
      topPlayers
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Reset leaderboard
app.delete('/leaderboard', async (req: Request, res: Response) => {
  try {
    await leaderboard.reset();

    io.emit('leaderboard:reset');

    res.json({ message: 'Leaderboard reset' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// === SOCKET.IO REAL-TIME EVENTS ===

io.on('connection', (socket: Socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // Send initial leaderboard
  leaderboard.getTopPlayers(10).then(players => {
    socket.emit('leaderboard:initial', players);
  });

  // Handle score update from client
  socket.on('score:submit', async (data: ScoreSubmitData) => {
    try {
      const { playerId, score, username } = data;
      const result = await leaderboard.updateScore(playerId, score, { username });

      // Broadcast to all clients
      const topPlayers = await leaderboard.getTopPlayers(10);
      io.emit('leaderboard:update', topPlayers);
      io.emit('score:update', result);

    } catch (error: any) {
      socket.emit('error', { message: error.message });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
  });
});

// === HTML CLIENT ===

app.get('/', (req: Request, res: Response) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <title>Real-time Leaderboard</title>
  <script src="/socket.io/socket.io.js"></script>
  <style>
    body { font-family: Arial, sans-serif; max-width: 800px; margin: 50px auto; padding: 20px; }
    h1 { color: #333; }
    .controls { margin: 20px 0; padding: 20px; background: #f5f5f5; border-radius: 8px; }
    input, button { padding: 10px; margin: 5px; font-size: 16px; }
    button { background: #4CAF50; color: white; border: none; cursor: pointer; border-radius: 4px; }
    button:hover { background: #45a049; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #4CAF50; color: white; }
    tr:hover { background: #f5f5f5; }
    .rank { font-weight: bold; color: #4CAF50; }
    .status { margin: 10px 0; padding: 10px; background: #e3f2fd; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>🏆 Real-time Leaderboard</h1>

  <div class="controls">
    <h3>Submit Score</h3>
    <input type="text" id="playerId" placeholder="Player ID" value="player_${Math.floor(Math.random()*1000)}">
    <input type="text" id="username" placeholder="Username" value="User ${Math.floor(Math.random()*1000)}">
    <input type="number" id="score" placeholder="Score" value="0">
    <button onclick="submitScore()">Submit Score</button>
    <button onclick="incrementScore()">+10 Points</button>
  </div>

  <div class="status" id="status">Connected</div>

  <h2>Top 10 Players</h2>
  <table id="leaderboard">
    <thead>
      <tr>
        <th>Rank</th>
        <th>Player ID</th>
        <th>Username</th>
        <th>Score</th>
        <th>Last Updated</th>
      </tr>
    </thead>
    <tbody id="leaderboardBody">
      <tr><td colspan="5">Loading...</td></tr>
    </tbody>
  </table>

  <script>
    const socket = io();

    socket.on('connect', () => {
      document.getElementById('status').innerHTML = '✅ Connected';
    });

    socket.on('disconnect', () => {
      document.getElementById('status').innerHTML = '❌ Disconnected';
    });

    socket.on('leaderboard:initial', (players) => {
      updateLeaderboard(players);
    });

    socket.on('leaderboard:update', (players) => {
      updateLeaderboard(players);
    });

    socket.on('score:update', (data) => {
      document.getElementById('status').innerHTML =
        \`✅ Score updated: \${data.playerId} - \${data.score} points (Rank #\${data.rank})\`;
    });

    function updateLeaderboard(players) {
      const tbody = document.getElementById('leaderboardBody');
      tbody.innerHTML = players.map(p => \`
        <tr>
          <td class="rank">#\${p.rank}</td>
          <td>\${p.playerId}</td>
          <td>\${p.username || 'N/A'}</td>
          <td><strong>\${p.score}</strong></td>
          <td>\${p.lastUpdated ? new Date(parseInt(p.lastUpdated)).toLocaleTimeString() : 'N/A'}</td>
        </tr>
      \`).join('');
    }

    function submitScore() {
      const playerId = document.getElementById('playerId').value;
      const username = document.getElementById('username').value;
      const score = parseInt(document.getElementById('score').value);

      socket.emit('score:submit', { playerId, username, score });
    }

    function incrementScore() {
      const playerId = document.getElementById('playerId').value;
      const currentScore = parseInt(document.getElementById('score').value);
      const newScore = currentScore + 10;

      document.getElementById('score').value = newScore;
      submitScore();
    }
  </script>
</body>
</html>
  `);
});

const PORT = 3004;
server.listen(PORT, () => {
  console.log(`🚀 Leaderboard server running on http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT} in multiple browser windows to see real-time updates`);
});

process.on('SIGTERM', async () => {
  await redis.quit();
  process.exit(0);
});
