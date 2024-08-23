# Redis Example

This project demonstrates how to set up and use Redis in both standalone and cluster configurations using Docker.

## Prerequisites

Before you begin, ensure you have the following installed:

- [Docker](https://docs.docker.com/compose/install/)
- Yarn v1.22.17 or higher
- Node.js v14.17.0 or higher

## Standalone Redis Instance

### 1. Start Redis Using Docker

To start a standalone Redis instance, run the following command:

```bash
yarn run start-redis
```

This will initiate the Redis container using the configuration in `docker-compose.yml`:

```yaml
cache:
  image: redis:latest
  container_name: redis-cache
  restart: always
  ports:
    - "6379:6379"
```

This configuration sets up a Redis cache service listening on port 6379, which is typical for single-instance Redis deployments.

### 2. Start the Example Application

To start the example application using the standalone Redis instance, run:

```bash
yarn run start:single
```

### 3. Test the Application

You can test the APIs as follows:

- API without Redis caching: `/getphoto`
- API with Redis caching: `/getphoto-redis`

## Redis Cluster

A Redis cluster is an advanced configuration that enhances performance, scalability, and fault tolerance by distributing data across multiple nodes.

### 1. Start Redis Cluster Using Docker

Run the following command to start the Redis cluster:

```bash
yarn run start-redis
```

In the `docker-compose.yml` file, the following environment variables are used:

- `ALLOW_EMPTY_PASSWORD`: Allows connections to the cluster without requiring credentials.
- `REDIS_NODES`: Specifies the hostnames of all nodes in the cluster, separated by spaces.
- `REDIS_CLUSTER_REPLICAS: 1`: Configures the cluster with three master nodes and three replica nodes across six nodes.

Execute the command to launch the Redis cluster:

```bash
docker-compose up
```

Logs:
```
redis-node-5  | >>> Performing Cluster Check (using node 172.18.0.2:6379)
redis-node-5  | M: 025420b382c7d631ebfe4959b346eaf255caeaba 172.18.0.2:6379
redis-node-5  |    slots:[0-5460] (5461 slots) master
redis-node-5  |    1 additional replica(s)
redis-node-5  | S: 1d693ab3d6b630768359615889bfcdc69642cea3 172.18.0.5:6379
redis-node-5  |    slots: (0 slots) slave
redis-node-5  |    replicates 025420b382c7d631ebfe4959b346eaf255caeaba
redis-node-5  | M: 9239ec8481a3ec411dd0f2f832d0f7a4b07472ef 172.18.0.6:6379
redis-node-5  |    slots:[10923-16383] (5461 slots) master
redis-node-5  |    1 additional replica(s)
redis-node-5  | S: 4d8b42ab42c2f589f31ea2310ccc630a899d71f1 172.18.0.7:6379
redis-node-5  |    slots: (0 slots) slave
redis-node-5  |    replicates 9c5e768c2aaae24e48bb62c0be8395d13592a940
redis-node-5  | S: 07fc9c307fc4fca6371e8832821638d412c8c350 172.18.0.4:6379
redis-node-5  |    slots: (0 slots) slave
redis-node-5  |    replicates 9239ec8481a3ec411dd0f2f832d0f7a4b07472ef
redis-node-5  | M: 9c5e768c2aaae24e48bb62c0be8395d13592a940 172.18.0.3:6379
redis-node-5  |    slots:[5461-10922] (5462 slots) master
redis-node-5  |    1 additional replica(s)
redis-node-5  | [OK] All nodes agree about slots configuration.
redis-node-5  | >>> Check for open slots...
redis-node-5  | >>> Check slots coverage...
redis-node-5  | [OK] All 16384 slots covered.
redis-node-5  | Cluster correctly created
```

You should see output indicating the successful creation of the cluster:

```
redis-node-5  | >>> Performing Cluster Check (using node 172.18.0.2:6379)
...
redis-node-5  | [OK] All 16384 slots covered.
redis-node-5  | Cluster correctly created
```

### 2. Connect to the Redis Cluster

To connect to a specific Redis container, list all running containers:

```bash
docker ps
```

Then, use the following command to access the container:

```bash
docker exec -it <container_id> sh
```

Once inside the container, you can start the Redis CLI:

```bash
redis-cli -c
```

To view all nodes in the cluster, run:

```bash
CLUSTER NODES
```

Logs:
```
127.0.0.1:6379> CLUSTER NODES
82d2bee961c7a4b73f099550d72a232e55d12d60 172.18.0.2:6379@16379 master - 0 1683707451345 2 connected 5461-10922
e09bd0f03f71d5ca9e1db6804ac28f2470eb70db 172.18.0.7:6379@16379 myself,slave 82d2bee961c7a4b73f099550d72a232e55d12d60 0 1683707449000 2 connected
8cb609962e074807b56f1a01bbbde3e6a436e7ca 172.18.0.3:6379@16379 master - 0 1683707450331 1 connected 0-5460
7dd24d5ffc732189f7b32a5468d9b20ebc1f60d7 172.18.0.5:6379@16379 master - 0 1683707450000 3 connected 10923-16383
c02f2c7285074d9d5b23b8faf07ec287c6e94636 172.18.0.4:6379@16379 slave 8cb609962e074807b56f1a01bbbde3e6a436e7ca 0 1683707449316 1 connected
5105b2780cabbff516e0f834a694bcdca310e8b7 172.18.0.6:6379@16379 slave 7dd24d5ffc732189f7b32a5468d9b20ebc1f60d7 0 1683707448291 3 connected
```

You can now set a value in the cluster:

```bash
SET key "value"
```

```
127.0.0.1:6379> SET key "value"
-> Redirected to slot [12539] located at 172.18.0.5:6379
OK
```

### 3. Running the Example Application

Start the application configured for the Redis cluster:

```bash
yarn run start:multiple
```

### 4. Test the Application

Test the APIs as follows:

- API without Redis caching: `/getphoto`
- API with Redis caching: `/getphoto-redis`

## Outside Docker Network (MacOS)

For MacOS, to connect to the Redis cluster from outside the Docker network, first retrieve your external host IP:

```bash
echo "$(route get uninterrupted.tech | grep interface | sed -e 's/.*: //' | xargs ipconfig getifaddr)"
```

Update the `REDIS_NODES` environment variable in the `docker-compose.yml` file with the retrieved IP:

```yaml
REDIS_NODES: <external_ip>:6370 <external_ip>:6371 <external_ip>:6372 <external_ip>:6373 <external_ip>:6374 <external_ip>:6375
```

You can then connect to the Redis cluster and run the `CLUSTER NODES` command as described earlier.
```
❯ redis-cli -c -h 192.168.1.13 -p 6375
127.0.0.1:6375> CLUSTER NODES
275c337ffe6073071088bb0706a2536608c03fe9 192.168.1.184:6372@16372 master - 0 1683717016000 3 connected 10923-16383
0e779e30ce3879ee37b470b299a97d41c0e16779 192.168.1.184:6370@16370 master - 0 1683717018000 1 connected 0-5460
3e7dc06681938425f71a39a2a7d189b336132e4a 192.168.1.184:6374@16374 slave 0e779e30ce3879ee37b470b299a97d41c0e16779 0 1683717020706 1 connected
841b05c2890454b345da8380ee63fa41c03fae6b 192.168.1.184:6371@16371 master - 0 1683717020000 2 connected 5461-10922
44444520eb2bbc346ab4dba9b1c495973399a227 192.168.1.184:6375@16375 myself,slave 841b05c2890454b345da8380ee63fa41c03fae6b 0 1683717017000 2 connected
8f14d7d1faac0e131d315ee34c0c7fc3836716c9 192.168.1.184:6373@16373 slave 275c337ffe6073071088bb0706a2536608c03fe9 0 1683717019000 3 connected
```