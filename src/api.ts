import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import axios from 'axios';
import { createClient } from 'redis';

const app = express();
const RedisClient = createClient({
    //redis[s]://[[username][:password]@][host][:port][/db-number]
    url: 'redis://:@localhost:6379'
});

const DEFAULT_EXPIRED = 3600;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({
    extended: true
}));

// Routes
app.get('/check', (req, res) => {
    res.status(200).send('heath check OK');
});

app.get('/getphoto', async (req, res) => {
    const { data } = await axios.get("https://jsonplaceholder.typicode.com/photos");

    return res.json(data);
});

app.get('/getphoto-redis', async (req, res) => {
    //cache using redis
    const photo = await RedisClient.get('photo');

    if (!!photo) {
        return res.json(JSON.parse(photo))
    } else {
        const { data } = await axios.get("https://jsonplaceholder.typicode.com/photos");
        RedisClient.set('photo', JSON.stringify(data));
        return res.json((data))
    }
});
// Start
const appPort = 4000;
RedisClient.connect().then(async () => {
    app.listen(appPort, () => {
        console.info(`Example app listening on port ${appPort}!`);
    });
});
