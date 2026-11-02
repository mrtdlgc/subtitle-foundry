import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-foundry-branding-'));
const socket = net.createServer().listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/API_KEY|TOKEN|SECRET|PASSWORD|MASTER_KEY|COOKIES|YOUTUBE_BROWSER|CODEX_HOME/i.test(key))
    delete env[key];
const server = spawn(process.execPath, ['build/server.js'], {
  env: {
    ...env,
    DATA_DIR: root,
    APP_MODE: 'personal',
    APP_PASSWORD: 'branding-fixture-password',
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_ORIGIN: origin,
    BASE_PATH: '',
    SCANNER_ENABLED: 'false',
    SHUTDOWN_GRACE_MS: '1000',
    CODEX_BIN: '/not-available',
    YTDLP_BIN: '/not-available',
    LOCAL_AUDIO_ENABLED: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '',
  browser;
server.stdout.on('data', (chunk) => (logs += chunk));
server.stderr.on('data', (chunk) => (logs += chunk));
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(logs);
    if (
      await fetch(origin + '/health')
        .then((r) => r.ok)
        .catch(() => false)
    ) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, logs);
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/brave-browser',
    headless: true,
    args: ['--disable-gpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  assert.match(await page.title(), /Subtitle Foundry/);
  assert.equal(
    await page.locator('.brand-mark').evaluate((img) => img.complete && img.naturalWidth > 0),
    true,
  );
  await page.screenshot({ path: '/tmp/subtitle-foundry-login.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/subtitle-foundry-login-mobile.png', fullPage: true });
  await page.locator('#password').fill('branding-fixture-password');
  await page.locator('#loginForm button[type=submit]').click();
  await page.locator('#studio-title').waitFor();
  assert.match(await page.title(), /Subtitle Foundry/);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: '/tmp/subtitle-foundry-studio-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '/tmp/subtitle-foundry-studio.png', fullPage: true });
  assert.equal(await page.locator('.workflow-preview li').count(), 5);
  assert.ok(
    (await page.context().cookies()).some((cookie) => cookie.name === 'subtitle-foundry_session'),
  );

  const result = await page.evaluate(async () => {
    const { reviewStorageKey } = await import('./storage-compat.js');
    const suffix = 'corrections-v2:/:brand-fixture';
    localStorage.setItem(`yesilcam-${suffix}`, 'unsent correction');
    const key = reviewStorageKey(suffix);
    const draft = localStorage.getItem(key);
    const { readLocalWaveform } = await import('./local-files.js');
    await readLocalWaveform('missing-source');
    const createdLegacyDatabase = (await indexedDB.databases()).some(
      (database) => database.name === 'yesilcam-local-waveforms',
    );
    const waveform = { version: 1, duration: 2, binsPerSecond: 1, peaks: 'AQI=', rms: 'AQI=' };
    const open = (name) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('waveforms');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
    const previous = await open('yesilcam-local-waveforms');
    await new Promise((resolve, reject) => {
      const tx = previous.transaction('waveforms', 'readwrite');
      tx.objectStore('waveforms').put(waveform, 'source-fingerprint');
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
    previous.close();
    const recovered = await readLocalWaveform('source-fingerprint');
    const current = await open('subtitle-foundry-local-waveforms');
    const copied = await new Promise((resolve, reject) => {
      const request = current
        .transaction('waveforms')
        .objectStore('waveforms')
        .get('source-fingerprint');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    current.close();
    return { draft, recovered, copied, waveform, createdLegacyDatabase };
  });
  assert.equal(result.draft, 'unsent correction');
  assert.equal(result.createdLegacyDatabase, false);
  assert.deepEqual(result.recovered, result.waveform);
  assert.deepEqual(result.copied, result.waveform);
  await page.goto(origin + '/review-player.html');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'review fits mobile',
  );
  assert.match(await page.locator('.brand').innerText(), /SUBTITLE\s+FOUNDRY/);
  assert.deepEqual(errors, []);
  console.log(
    'Branding browser checks passed: desktop/mobile, login, session namespace, drafts and waveform migration.',
  );
} finally {
  await browser?.close();
  if (server.exitCode === null) {
    const exit = once(server, 'exit');
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 3000);
    await exit;
    clearTimeout(timer);
  }
  await fs.rm(root, { recursive: true, force: true });
}
