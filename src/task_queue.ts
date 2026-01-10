/* 
**Test it:**
```bash
# Add jobs
curl -X POST http://localhost:3003/jobs \
  -H "Content-Type: application/json" \
  -d '{"task":"process_payment","amount":100}'
curl -X POST http://localhost:3003/jobs \
  -H "Content-Type: application/json" \
  -d '{"task":"send_email","to":"user@example.com"}'
# Add multiple jobs
for i in {1..10}; do
  curl -X POST http://localhost:3003/jobs \
    -H "Content-Type: application/json" \
    -d "{\"task\":\"batch_job_$i\",\"index\":$i}"
done
# Get stats
curl http://localhost:3003/jobs/stats
# Get completed jobs
curl http://localhost:3003/jobs/completed
# Get failed jobs
curl http://localhost:3003/jobs/failed
# Clear completed queue
curl -X DELETE http://localhost:3003/jobs/completed
```
*/
import 'dotenv/config';
import express, { Request, Response } from 'express';
import { Redis } from 'ioredis';

const NUM_WORKERS = 3;
const workers: Worker[] = [];

const QUEUE_NAME = 'job_queue';
const QUEUE_PROCESSING = 'job_queue:processing';
const QUEUE_COMPLETED = 'job_queue:completed';
const QUEUE_FAILED = 'job_queue:failed';

// Job status pub/sub channel
const JOB_STATUS_CHANNEL = 'job_status';

const app = express();
app.use(express.json());

//Add jobs to the queue
const redisProducer = new Redis({
  host: 'localhost',
  port: 6379,
  // Optional: Add reconnection strategy
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
});

// Handle Redis connection events
redisProducer.on('connect', () => console.log('✅ redisProducer connected'));
redisProducer.on('error', (err) => console.error('❌ redisProducer error:', err));

//Publish job status events 
const redisPubSub = new Redis({
  host: 'localhost',
  port: 6379,
  // Optional: Add reconnection strategy
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  }
});

// Handle Redis connection events
redisPubSub.on('connect', () => console.log('✅ redisPubSub connected'));
redisPubSub.on('error', (err) => console.error('❌ redisPubSub error:', err));

interface Job {
  id: string;
  data: any;
  createdAt: string;
  status: string;
  attempts: number;
  result?: string;
  processingTime?: number;
  completedAt?: string;
  error?: string;
  failedAt?: string;
}

class JobQueue {
  private redis: Redis;
  private pubSubRedis: Redis;

  constructor(redis: Redis, pubSubRedis: Redis) {
    this.redis = redis;
    this.pubSubRedis = pubSubRedis;
  }

  /**
   * Add job to queue
   */
  async addJob(jobData: any): Promise<Job> {
    const job = {
      id: `job_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      data: jobData,
      createdAt: new Date().toISOString(),
      status: 'queued',
      attempts: 0
    };

    // Add to queue (LPUSH adds to left, BRPOP removes from right = FIFO)
    await this.redis.lpush(QUEUE_NAME, JSON.stringify(job));
    
    // Publish event
    await this.pubSubRedis.publish(JOB_STATUS_CHANNEL, JSON.stringify({
      jobId: job.id,
      status: 'queued',
      timestamp: new Date().toISOString()
    }));

    return job;
  }

  /**
   * Get queue stats
   */
  async getStats(): Promise<{ queued: number; processing: number; completed: number; failed: number }> {
    const [queued, processing, completed, failed] = await Promise.all([
      this.redis.llen(QUEUE_NAME),
      this.redis.llen(QUEUE_PROCESSING),
      this.redis.llen(QUEUE_COMPLETED),
      this.redis.llen(QUEUE_FAILED)
    ]);

    return { queued, processing, completed, failed };
  }

  /**
   * Get jobs from a specific queue
   */
  async getJobs(queueName: string, start: number = 0, end: number = -1): Promise<Job[]> {
    const jobs = await this.redis.lrange(queueName, start, end);
    return jobs.map(job => JSON.parse(job));
  }

  /**
   * Clear a specific queue
   */
  async clearQueue(queueName: string): Promise<void> {
    await this.redis.del(queueName);
  }
}

class Worker {
  private workerId: number;
  private redis: Redis;
  private pubSubRedis: Redis;
  private isRunning: boolean;

  constructor(workerId: number, redis: Redis, pubSubRedis: Redis) {
    this.workerId = workerId;
    this.redis = redis;
    this.pubSubRedis = pubSubRedis;
    this.isRunning = false;
  }

  /**
   * Simulate job processing
   */
  async processJob(job: Job): Promise<Job> {
    console.log(`[Worker ${this.workerId}] Processing job ${job.id}...`);
    
    // Simulate work with random duration
    const processingTime = Math.random() * 3000 + 1000; // 1-4 seconds
    await new Promise(resolve => setTimeout(resolve, processingTime));
    
    // Simulate occasional failures (10% chance)
    if (Math.random() < 0.1) {
      throw new Error('Random processing error');
    }

    return {
      ...job,
      result: `Processed by worker ${this.workerId}`,
      processingTime: Math.round(processingTime),
      completedAt: new Date().toISOString()
    };
  }

  /**
   * Start worker
   */
  async start(): Promise<void> {
    this.isRunning = true;
    console.log(`✅ [Worker ${this.workerId}] Started`);

    while (this.isRunning) {
      try {
        // Blocking pop from queue (waits up to 5 seconds)
        const result = await this.redis.brpop(QUEUE_NAME, 5);
        
        if (!result) {
          // Timeout, no job available
          continue;
        }

        const [, jobData] = result;
        const job = JSON.parse(jobData);
        
        // Move to processing queue
        await this.redis.lpush(QUEUE_PROCESSING, jobData);
        job.attempts++;

        // Publish status
        await this.pubSubRedis.publish(JOB_STATUS_CHANNEL, JSON.stringify({
          jobId: job.id,
          status: 'processing',
          workerId: this.workerId,
          timestamp: new Date().toISOString()
        }));

        try {
          // Process the job
          const completedJob = await this.processJob(job);
          
          // Move to completed queue
          await this.redis.lrem(QUEUE_PROCESSING, 1, jobData);
          await this.redis.lpush(QUEUE_COMPLETED, JSON.stringify(completedJob));
          
          // Publish completion
          await this.pubSubRedis.publish(JOB_STATUS_CHANNEL, JSON.stringify({
            jobId: job.id,
            status: 'completed',
            workerId: this.workerId,
            timestamp: new Date().toISOString()
          }));

          console.log(`✅ [Worker ${this.workerId}] Completed job ${job.id}`);

        } catch (error: any) {
          console.error(`❌ [Worker ${this.workerId}] Job ${job.id} failed:`, error.message);

          // Move to failed queue
          await this.redis.lrem(QUEUE_PROCESSING, 1, jobData);
          await this.redis.lpush(QUEUE_FAILED, JSON.stringify({
            ...job,
            error: error.message,
            failedAt: new Date().toISOString()
          }));

          // Publish failure
          await this.pubSubRedis.publish(JOB_STATUS_CHANNEL, JSON.stringify({
            jobId: job.id,
            status: 'failed',
            workerId: this.workerId,
            error: error.message,
            timestamp: new Date().toISOString()
          }));
        }

      } catch (error: any) {
        console.error(`[Worker ${this.workerId}] Error:`, error);
      }
    }

    console.log(`🛑 [Worker ${this.workerId}] Stopped`);
  }

  stop(): void {
    this.isRunning = false;
  }
}

const jobQueue = new JobQueue(redisProducer, redisPubSub);

// Add job to queue
app.post('/jobs', async (req: Request, res: Response) => {
  try {
    const job = await jobQueue.addJob(req.body);
    res.status(201).json(job);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get queue statistics
app.get('/jobs/stats', async (req: Request, res: Response) => {
  try {
    const stats = await jobQueue.getStats();
    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get jobs from specific queue
app.get('/jobs/:queueType', async (req: Request, res: Response) => {
  try {
    const { queueType } = req.params;
    const queueMap: Record<string, string> = {
      'queued': QUEUE_NAME,
      'processing': QUEUE_PROCESSING,
      'completed': QUEUE_COMPLETED,
      'failed': QUEUE_FAILED
    };

    const queueName = queueMap[queueType];
    if (!queueName) {
      return res.status(400).json({ error: 'Invalid queue type' });
    }

    const jobs = await jobQueue.getJobs(queueName, 0, 9); // Get first 10
    res.json({ queueType, count: jobs.length, jobs });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Clear queue
app.delete('/jobs/:queueType', async (req: Request, res: Response) => {
  try {
    const { queueType } = req.params;
    const queueMap: Record<string, string> = {
      'queued': QUEUE_NAME,
      'processing': QUEUE_PROCESSING,
      'completed': QUEUE_COMPLETED,
      'failed': QUEUE_FAILED
    };

    const queueName = queueMap[queueType];
    if (!queueName) {
      return res.status(400).json({ error: 'Invalid queue type' });
    }

    await jobQueue.clearQueue(queueName);
    res.json({ message: `${queueType} queue cleared` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Routes
app.get('/check', (req: Request, res: Response) => {
  res.status(200).send('health check OK');
});


const appPort = 3003;
app.listen(appPort, async () => {
    console.info(`Example app listening on port ${appPort}!`);

      // Start workers
      for (let i = 1; i <= NUM_WORKERS; i++) {
        //Worker-specific job processing operations
        const workerRedis = new Redis({ host: 'localhost', port: 6379 });
        const worker = new Worker(i, workerRedis, redisPubSub);
        workers.push(worker);
        
        // Run worker in background
        worker.start().catch(console.error);
      }
    
      //Subscribe to job status updates (Monitor/Logging)
      const subscriber = new Redis({ host: 'localhost', port: 6379 });
      await subscriber.subscribe(JOB_STATUS_CHANNEL);
      
      subscriber.on('message', (channel, message) => {
        const event = JSON.parse(message);
        console.log(`📢 [Event] Job ${event.jobId}: ${event.status}`, 
          event.workerId ? `(worker ${event.workerId})` : '');
      });
});