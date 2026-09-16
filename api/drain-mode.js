import { createClient } from 'redis';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();

  try {
    if (req.method === 'POST') {
      // Sécurité admin
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const token = authHeader.split(' ')[1];
      if (!process.env.ADMIN_SECRET || token !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const { mode } = req.body;
      if (mode !== 'auto' && mode !== 'manual') {
        return res.status(400).json({ error: 'Mode invalide' });
      }

      await client.set('drain:mode', mode);
      return res.status(200).json({ success: true, mode });
    }

    if (req.method === 'GET') {
      const mode = await client.get('drain:mode') || 'auto';
      return res.status(200).json({ mode });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  } finally {
    await client.disconnect();
  }
}
