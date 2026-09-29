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

      const { mode, chain } = req.body;
      const allowed = ['1', '8453', '42161', '10', '137', '43114'];
      if (mode && mode !== 'auto' && mode !== 'manual') {
        return res.status(400).json({ error: 'Mode invalide' });
      }
      if (chain && !allowed.includes(String(chain))) {
        return res.status(400).json({ error: 'Chain invalide' });
      }
      if (mode) await client.set('drain:mode', mode);
      if (chain) await client.set('drain:chain', String(chain));
      const savedMode = await client.get('drain:mode') || 'auto';
      const savedChain = await client.get('drain:chain') || '1';
      return res.status(200).json({ success: true, mode: savedMode, chain: savedChain });
    }

    if (req.method === 'GET') {
      const mode = await client.get('drain:mode') || 'auto';
      const chain = await client.get('drain:chain') || '1';
      return res.status(200).json({ mode, chain });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  } finally {
    await client.disconnect();
  }
}
