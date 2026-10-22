const express = require('express');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = path.join(__dirname, '.auth');
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

let sock = null;
let connecting = false;
let connected = false;
let pairingCode = '';
let lastError = '';
let phoneForPairing = '';
let pairRequestedAt = 0;
let restartTimer = null;

function cleanPhone(value) {
  return String(value || '').replace(/\D/g, '');
}
function status() {
  return {
    ok: true,
    connected,
    connecting,
    pairingCode: pairingCode || null,
    phone: phoneForPairing || null,
    lastError: lastError || null
  };
}

async function startSocket() {
  if (connecting || connected) return;
  connecting = true;
  lastError = '';
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch (_) {}
    sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['THENUVA X MD', 'Chrome', '2.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        connected = true;
        connecting = false;
        pairingCode = '';
        lastError = '';
      } else if (connection === 'close') {
        connected = false;
        connecting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          clearTimeout(restartTimer);
          restartTimer = setTimeout(() => startSocket().catch(() => {}), 2500);
        } else {
          lastError = 'WhatsApp logged out. Clear the saved session and pair again.';
        }
      }
    });
    sock.ev.on('messages.upsert', () => {});
    connecting = false;
  } catch (err) {
    connecting = false;
    lastError = err.message || 'Could not start Baileys';
    throw err;
  }
}

app.get('/api/status', (_req, res) => res.json(status()));

app.post('/api/pair', async (req, res) => {
  const phone = cleanPhone(req.body?.phone);
  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({ error: 'Enter your WhatsApp number with country code, digits only.' });
  }
  if (connected) return res.status(409).json({ error: 'A WhatsApp session is already connected.' });
  if (Date.now() - pairRequestedAt < 30000) {
    return res.status(429).json({ error: 'Please wait 30 seconds before requesting another code.' });
  }
  pairRequestedAt = Date.now();
  phoneForPairing = phone;
  try {
    if (!sock) await startSocket();
    if (sock?.user) return res.status(409).json({ error: 'This session is already connected.' });
    const code = await sock.requestPairingCode(phone);
    pairingCode = String(code).match(/.{1,4}/g)?.join('-') || String(code);
    return res.json({ ok: true, pairingCode, message: 'Open WhatsApp > Linked devices > Link a device > Link with phone number instead.' });
  } catch (err) {
    lastError = err.message || 'Pair code request failed';
    return res.status(500).json({ error: 'Could not create Pair Code. Check the server console and try again.' });
  }
});

/*
 * Session export: exports the entire Baileys multi-file auth directory as
 * a JSON bundle encoded in base64. This is NOT the same as a legacy
 * creds-only SESSION_ID. The receiving bot must implement the matching
 * THENUVA_SESSION_BUNDLE format or restore the files from the downloaded ZIP.
 */
app.get('/api/session', (req, res) => {
  const exportToken = process.env.SESSION_EXPORT_TOKEN;
  const suppliedToken = Buffer.from(String(req.get('x-session-export-token') || ''));
  const expectedToken = Buffer.from(String(exportToken || ''));
  if (!exportToken || suppliedToken.length !== expectedToken.length || !crypto.timingSafeEqual(suppliedToken, expectedToken)) {
    return res.status(403).json({ error: 'Session export is locked. Set SESSION_EXPORT_TOKEN in Replit Secrets and enter it in the website.' });
  }
  if (!connected) return res.status(409).json({ error: 'Pair and connect WhatsApp before exporting the session.' });
  try {
    const entries = fs.readdirSync(AUTH_DIR, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.json'));
    const bundle = {};
    for (const entry of entries) {
      bundle[entry.name] = fs.readFileSync(path.join(AUTH_DIR, entry.name), 'utf8');
    }
    if (!Object.keys(bundle).length) throw new Error('No auth files found');
    const payload = JSON.stringify({ format: 'THENUVA_SESSION_BUNDLE_V1', createdAt: new Date().toISOString(), files: bundle });
    const sessionId = 'THENUVA-XMD~' + Buffer.from(payload).toString('base64');
    res.json({ ok: true, sessionId, format: 'THENUVA_SESSION_BUNDLE_V1', warning: 'Treat this as a password. Anyone with it may access your WhatsApp session.' });
  } catch (err) {
    res.status(500).json({ error: 'Session export failed. ' + (err.message || '') });
  }
});

app.post('/api/reset', async (_req, res) => {
  try {
    if (sock) {
      try { sock.end(undefined); } catch (_) {}
    }
    sock = null;
    connected = false;
    connecting = false;
    pairingCode = '';
    phoneForPairing = '';
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    res.json({ ok: true, message: 'Local session cleared. Pair again to connect.' });
  } catch (_) {
    res.status(500).json({ error: 'Could not clear the session.' });
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`THENUVA X MD Pair Web running on port ${PORT}`);
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    startSocket().catch(err => console.error('Restore error:', err.message));
  }
});