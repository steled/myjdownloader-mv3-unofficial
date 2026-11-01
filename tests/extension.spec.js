// Smoke tests: load the unpacked extension in Chromium and check that its main
// parts still work, e.g. after updating the vendored libraries.
// Not covered: login and device list (need a real MyJDownloader account).
const { test, expect, chromium } = require('@playwright/test');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const extensionPath = path.resolve(__dirname, '..');
const manifest = require('../manifest.json');

let context;
let extensionId;
let pageServer;
let pageBase;
let cnlServer;
const cnlHits = [];

function listen(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

// The service worker is stopped when idle, so always look it up again.
async function getServiceWorker() {
  const [sw] = context.serviceWorkers();
  return sw || context.waitForEvent('serviceworker');
}

test.beforeAll(async () => {
  // Plays the part of JDownloader's local Click'n'Load server. Nothing may reach it:
  // the extension has to intercept the requests (or redirect jdcheck.js) first.
  cnlServer = http.createServer((req, res) => {
    cnlHits.push(`${req.method} ${req.url}`);
    res.writeHead(404);
    res.end();
  });
  await listen(cnlServer, 9666);

  pageServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/jdcheck') {
      res.end('<html><body><script src="http://127.0.0.1:9666/jdcheck.js"></script></body></html>');
    } else {
      res.end('<html><body>test page</body></html>');
    }
  });
  await listen(pageServer, 0);
  pageBase = `http://127.0.0.1:${pageServer.address().port}`;

  context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'myjd-pw-')), {
    headless: false, // extensions need a headed browser; CI runs this under xvfb
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const sw = await getServiceWorker();
  extensionId = new URL(sw.url()).host;
  // Record the Click'n'Load messages the relay sends. The in-page toolbar may empty the queue
  // right away when nobody is logged in, so the queue itself is not a reliable witness.
  await sw.evaluate(() => {
    globalThis.__cnl = [];
    chrome.runtime.onMessage.addListener((m) => {
      if (m && m.name === "myjd-cnl") globalThis.__cnl.push(m.data.formData);
    });
  });
});

test.afterAll(async () => {
  await context?.close();
  pageServer?.close();
  cnlServer?.close();
});

test('service worker starts with the manifest version', async () => {
  const sw = await getServiceWorker();
  expect(await sw.evaluate(() => chrome.runtime.getManifest().version)).toBe(manifest.version);
});

test('popup boots AngularJS without errors and shows the login form', async () => {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && /\$injector|\$compile|\$rootScope|Unknown provider|is not defined|is not a function|Cannot read/.test(m.text())) {
      errors.push(m.text());
    }
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(page.locator('#emailInput')).toBeVisible({ timeout: 20_000 });
  expect(errors).toEqual([]);
  await page.close();
});

test('fetch POST to the Click\'n\'Load port is intercepted and forwarded to the service worker', async () => {
  const page = await context.newPage();
  await page.goto(`${pageBase}/`);
  const result = await page.evaluate(async () => {
    const res = await fetch('http://127.0.0.1:9666/flash/add', {
      method: 'POST',
      body: new URLSearchParams({ urls: 'http://example.com/a.zip', source: 'test', package: 'fetch-pkg' }),
    });
    return { status: res.status, text: await res.text() };
  });
  expect(result).toEqual({ status: 200, text: 'success' });
  await expect.poll(async () => (await getServiceWorker()).evaluate(
    (pkg) => globalThis.__cnl.filter((f) => f.package === pkg).length, 'fetch-pkg',
  )).toBe(1);
  expect(cnlHits).toEqual([]);
  await page.close();
});

test('XHR POST to the Click\'n\'Load port is intercepted and forwarded to the service worker', async () => {
  const page = await context.newPage();
  await page.goto(`${pageBase}/`);
  const result = await page.evaluate(() => new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'http://127.0.0.1:9666/flash/add');
    xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.send(new URLSearchParams({ urls: 'http://example.com/b.zip', source: 'test', package: 'xhr-pkg' }));
  }));
  expect(result).toEqual({ status: 200, text: 'success' });
  await expect.poll(async () => (await getServiceWorker()).evaluate(
    (pkg) => globalThis.__cnl.filter((f) => f.package === pkg).length, 'xhr-pkg',
  )).toBe(1);
  expect(cnlHits).toEqual([]);
  await page.close();
});

test('jdcheck.js is answered by the extension', async () => {
  const page = await context.newPage();
  await page.goto(`${pageBase}/jdcheck`);
  expect(await page.evaluate(() => window.jdownloader)).toBe(true);
  expect(cnlHits).toEqual([]);
  await page.close();
});
