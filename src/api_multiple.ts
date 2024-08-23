import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import axios from 'axios';
import { Cluster } from 'ioredis';
import { createPool, Options, Pool } from 'generic-pool';

let redisPools: { [key: string]: Pool<Cluster> } = {};

/**
 * Function to create and return a Redis client pool.
 * This function creates a connection pool for a Redis cluster.
 *
 * @param {string} poolName - Name of the pool for logging purposes.
 * @param {Array<{ host: string, port: number }>} redisClusterNodes - Array of cluster nodes with host and port information.
 * @returns {Pool<Cluster>} A pool of Redis client instances.
 */
const getRedisGenericPool = (
  poolName: string,
  redisClusterNodes: { host: string; port: number }[],
  options: Options
): Pool<Cluster> => {
  if (redisPools[poolName]) return redisPools[poolName];

  const redisPool = createPool<Cluster>(
    {
      create: async (): Promise<Cluster> => {
        const client = new Cluster(redisClusterNodes);

        client.on('connect', () => {
          console.info(`${poolName} Redis POOL element connecting`);
        });
        client.on('ready', () => {
          console.info(`${poolName} Redis POOL element connected`);
        });
        client.on('error', (e) => {
          console.error(`${poolName} Redis error`, e);
        });
        client.on('close', () => {
          console.info(`${poolName} Redis close`);
        });
        client.on('disconnected', () => {
          console.info(`${poolName} Redis disconnected`);
        });
        client.on('reconnecting', () => {
          console.info(`${poolName} Redis reconnecting`);
        });
        client.on('end', () => {
          console.info(`${poolName} Redis Pool closed all`);
        });

        // Return the client as a resolved promise
        return client;
      },
      destroy: (client: Cluster): Promise<void> => {
        return client.quit().then(() => {
          // Ensure the promise resolves to void
          return;
        });
      },
    },
    options,
  );

  redisPools[poolName] = redisPool;

  return redisPool;
};

const getMainPool = (): Pool<Cluster> => {
  const redisClusterNodes = [
    {
      host: "192.168.1.13",
      port: 6375,
      softIdleTimeoutMillis: 60000, // 1 minute
      evictionRunIntervalMillis: 30000, // 30 seconds
    },
  ];
  const poolName = 'Main';
  return getRedisGenericPool(poolName, redisClusterNodes, {
    min: 10,
    max: 20,
  });
};


const app = express();
const DEFAULT_EXPIRED = 3600;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/check', (req, res) => {
  res.status(200).send('health check OK');
});

app.get('/getphoto', async (req, res) => {
  const { data } = await axios.get("https://jsonplaceholder.typicode.com/photos");
  return res.json(data);
});

app.get('/getphoto-redis', async (req, res) => {
  const pool = getMainPool();
  const client = await pool.acquire();

  try {
    const photo = await client.get('photo');

    if (photo) {
      return res.json(JSON.parse(photo));
    } else {
      const { data } = await axios.get("https://jsonplaceholder.typicode.com/photos");
      await client.set('photo', JSON.stringify(data));
      return res.json(data);
    }
  } finally {
    pool.release(client);
  }
});

const appPort = 4040;
const pool = getMainPool();
pool.acquire().then(async (client) => {
  app.listen(appPort, () => {
    console.info(`Example app listening on port ${appPort}!`);
    pool.release(client);
  });
}).catch(err => {
  console.error('Failed to connect to Redis', err);
});
