import { ethers } from 'ethers';

const USDT_ADDR = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDT_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)'
];
const RPC_URL = 'https://eth-mainnet.g.alchemy.com/v2/demo';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { address } = req.query;
  if (!address || !ethers.utils.isAddress(address)) {
    return res.status(400).json({ error: 'Adresse invalide' });
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(USDT_ADDR, USDT_ABI, provider);
    const [balance, decimals] = await Promise.all([
      contract.balanceOf(address),
      contract.decimals()
    ]);
    const formatted = ethers.utils.formatUnits(balance, decimals);
    return res.status(200).json({ balance: formatted, balanceRaw: balance.toString(), decimals });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
