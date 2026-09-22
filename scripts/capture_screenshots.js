require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { query } = require('../server/db');
const { sign } = require('../server/utils/tokenUtils');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUTPUT_DIR = path.resolve(__dirname, '../docs/screenshots');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CDPClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.callbacks = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
    });
    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id && this.callbacks.has(msg.id)) {
          const { resolve, reject } = this.callbacks.get(msg.id);
          this.callbacks.delete(msg.id);
          if (msg.error) reject(msg.error);
          else resolve(msg.result);
        }
      } catch (err) {
        console.error('CDP message parse error:', err);
      }
    };
  }

  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function capture() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Fetch host user details
  const hostRows = query("SELECT user_id, party_code, username, role FROM users WHERE party_code = 'DEMO99' AND role = 'host'");
  if (!hostRows.length) {
    throw new Error('DEMO99 party host not found. Run seed_demo.js first.');
  }
  const host = hostRows[0];
  const hostToken = sign({
    userId: host.user_id,
    partyCode: host.party_code,
    role: host.role,
    username: host.username
  });
  const sessionObj = {
    userId: host.user_id,
    partyCode: host.party_code,
    role: host.role,
    username: host.username,
    token: hostToken
  };
  const adminSecret = process.env.ADMIN_SECRET || 'e7b4c1a9f3d2e5b8c0a4f6d8e1b3c5a7f9d2e4b6c8a0f2d4';

  const tempUserData = path.join(os.tmpdir(), `chrome-cdp-${Date.now()}`);
  const port = 9333;

  console.log('Launching headless Chrome...');
  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${tempUserData}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars'
  ]);

  try {
    let wsEndpoint = null;
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) {
          const data = await res.json();
          wsEndpoint = data.webSocketDebuggerUrl;
          break;
        }
      } catch {}
    }

    if (!wsEndpoint) {
      throw new Error('Failed to connect to Chrome debugging port');
    }

    console.log('Connected to Chrome DevTools endpoint');
    const browser = new CDPClient(wsEndpoint);

    // 1. Landing Page (1280x820)
    console.log('Capturing landing.png...');
    let { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    let page = new CDPClient(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false
    });
    await page.send('Page.navigate', { url: 'http://localhost:3002' });
    await sleep(2500);
    let ss = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUTPUT_DIR, 'landing.png'), Buffer.from(ss.data, 'base64'));
    console.log('Saved landing.png');
    page.close();
    await browser.send('Target.closeTarget', { targetId });

    // 2. Party Page (Desktop 1280x820)
    console.log('Capturing party.png...');
    ({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }));
    page = new CDPClient(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false
    });
    // Inject localStorage before any script runs!
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        localStorage.setItem('bb_user', ${JSON.stringify(JSON.stringify(sessionObj))});
        localStorage.setItem('bb_volume', '75');
      `
    });
    await page.send('Page.navigate', { url: 'http://localhost:3002/party.html?code=DEMO99' });
    await sleep(3500);
    ss = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUTPUT_DIR, 'party.png'), Buffer.from(ss.data, 'base64'));
    console.log('Saved party.png');
    page.close();
    await browser.send('Target.closeTarget', { targetId });

    // 3. Admin Dashboard (Desktop 1280x820)
    console.log('Capturing admin.png...');
    ({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }));
    page = new CDPClient(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false
    });
    // Inject admin token before script runs
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('admin_token', ${JSON.stringify(adminSecret)});`
    });
    await page.send('Page.navigate', { url: 'http://localhost:3002/admin.html' });
    await sleep(3500);
    ss = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUTPUT_DIR, 'admin.png'), Buffer.from(ss.data, 'base64'));
    console.log('Saved admin.png');
    page.close();
    await browser.send('Target.closeTarget', { targetId });

    // 4. Mobile Viewport (iPhone 14 / modern Android 390x844)
    console.log('Capturing mobile.png...');
    ({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }));
    page = new CDPClient(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        localStorage.setItem('bb_user', ${JSON.stringify(JSON.stringify(sessionObj))});
        localStorage.setItem('bb_volume', '80');
      `
    });
    await page.send('Page.navigate', { url: 'http://localhost:3002/party.html?code=DEMO99' });
    await sleep(3500);
    ss = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUTPUT_DIR, 'mobile.png'), Buffer.from(ss.data, 'base64'));
    console.log('Saved mobile.png');
    page.close();
    await browser.send('Target.closeTarget', { targetId });

    browser.close();
    console.log('All 4 screenshots captured successfully!');
  } finally {
    chromeProc.kill('SIGKILL');
    try {
      fs.rmSync(tempUserData, { recursive: true, force: true });
    } catch {}
  }
}

capture().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
