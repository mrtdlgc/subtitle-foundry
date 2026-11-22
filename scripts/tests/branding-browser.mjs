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
    CLAUDE_BIN: '/not-available',
    GROK_BIN: '/not-available',
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

  await page.locator('#pipelineTranslationOptions').waitFor();
  assert.equal(await page.locator('#pipelineTranslationConnection').inputValue(), 'codex-local');
  assert.deepEqual(
    await page
      .locator('#pipelineTranslationConnection option')
      .evaluateAll((options) => options.slice(0, 3).map((option) => option.value)),
    ['codex-local', 'claude-local', 'grok-local'],
  );
  await page.locator('#pipelineTranslationConnection').selectOption('claude-local');
  await page.locator('#pipelineTranslationModel').fill('sonnet');
  await page.locator('[data-view="translations"]').click();
  assert.equal(await page.locator('#translationConnection').inputValue(), 'claude-local');
  assert.equal(await page.locator('#codexModel').inputValue(), 'sonnet');
  await page.locator('#translationConnection').selectOption('grok-local');
  await page.locator('#codexModel').fill('grok-model');
  assert.equal(await page.locator('#pipelineTranslationConnection').inputValue(), 'grok-local');
  assert.equal(await page.locator('#pipelineTranslationModel').inputValue(), 'grok-model');
  await page.locator('#translationConnection').selectOption('xai-api');
  assert.equal(await page.locator('#codexModel').inputValue(), '');
  assert.ok(await page.locator('#startCodexTranslation').isDisabled());
  await page.locator('#translationConnection').selectOption('openrouter-api');
  assert.equal(await page.locator('#codexModel').inputValue(), '');
  assert.ok(await page.locator('#startCodexTranslation').isDisabled());
  await page.locator('#codexModel').fill('vendor/model');
  await page.locator('#translationConnection').selectOption('claude-local');
  assert.equal(await page.locator('#codexModel').inputValue(), 'sonnet');
  await page.locator('#translationConnection').selectOption('openrouter-api');
  assert.equal(await page.locator('#codexModel').inputValue(), 'vendor/model');
  await page.evaluate(async () => {
    const response = await fetch('/api/connections/OPENROUTER_API_KEY', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Subtitle-Foundry-Request': '1' },
      body: JSON.stringify({ value: 'browser-fixture-only' }),
    });
    if (!response.ok) throw new Error('Fixture connection failed');
  });
  await page.locator('#refreshTranslationsBtn').click();
  await page.waitForFunction(() => !document.querySelector('#startCodexTranslation').disabled);
  let submitted;
  await page.route('**/api/subtitle-translations', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    submitted = route.request().postDataJSON();
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Fixture stopped before inference' }),
    });
  });
  await page.locator('#translationUpload').setInputFiles({
    name: 'fixture.srt',
    mimeType: 'text/plain',
    buffer: Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nMerhaba.\n'),
  });
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/subtitle-translations') &&
        response.request().method() === 'POST',
    ),
    page.locator('#startCodexTranslation').click(),
  ]);
  assert.equal(submitted.translationProvider, 'openrouter-api');
  assert.equal(submitted.model, 'vendor/model');
  assert.match(submitted.content, /Merhaba/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({
    path: '/tmp/subtitle-foundry-translation-providers-mobile.png',
    fullPage: true,
  });

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
  await page.route('**/api/jobs?*', async (route) => {
    const now = Date.now();
    const jobs = ['responding', 'waiting', 'possibly-stalled', 'retrying'].map((state, index) => ({
      id: `activity-${index}`,
      title: `Activity fixture: ${state}`,
      type: 'translation',
      status: 'processing',
      progress: 87,
      logs: [],
      stages: [
        {
          id: 'translation',
          label: 'Subtitle translation',
          status: 'running',
          percentage: null,
          completed: 2,
          total: 16,
          unit: 'sections',
          retry:
            state === 'retrying'
              ? {
                  attempt: 1,
                  maximum: 3,
                  nextAt: new Date(now + 30000).toISOString(),
                  reason: 'the request timed out',
                }
              : null,
          activity: {
            startedAt: new Date(now - (index === 2 ? 360000 : 30000)).toISOString(),
            observedAt: new Date(now).toISOString(),
            lastDataAt: new Date(now - 2000).toISOString(),
            lastResponseAt: index === 0 ? new Date(now - 2000).toISOString() : null,
            lastRetryAt: null,
            responseEvents: index === 0 ? 3 : 0,
            receivedBytes: 500,
            timeoutMs: 1800000,
            visibility: 'events',
            scope: 'Section 3/16',
          },
        },
      ],
    }));
    await route.fulfill({ json: { jobs, total: jobs.length } });
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('[data-view="studio"]').click();
  await page.locator('#jobsList [data-activity="responding"]').waitFor();
  assert.match(
    await page.locator('#jobsList [data-activity="responding"] .stage-heading').innerText(),
    /Receiving response/,
  );
  assert.match(
    await page.locator('#jobsList [data-activity="waiting"] .stage-heading').innerText(),
    /Waiting for response/,
  );
  assert.match(
    await page.locator('#jobsList [data-activity="possibly-stalled"] .stage-heading').innerText(),
    /2\/16 sections · Possibly stalled/,
  );
  assert.match(
    await page
      .locator('#jobsList [data-activity="possibly-stalled"] .stage-activity-note')
      .innerText(),
    /do not confirm translation progress/,
  );
  await page
    .locator('#jobsList')
    .screenshot({ path: '/tmp/subtitle-foundry-translation-activity.png' });
  assert.match(
    await page.locator('#jobsList [data-activity="retrying"] .stage-heading').innerText(),
    /Automatic retry 1\/3/,
  );
  assert.match(
    await page.locator('#jobsList [data-activity="retrying"] .stage-detail').innerText(),
    /Retrying in/,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'activity status fits mobile',
  );
  await page.locator('#jobsList').screenshot({
    path: '/tmp/subtitle-foundry-translation-activity-mobile.png',
  });
  await page.goto(origin + '/review-player.html');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    'review fits mobile',
  );
  assert.match(await page.locator('.brand').innerText(), /SUBTITLE\s+FOUNDRY/);
  assert.deepEqual(errors, []);
  console.log(
    'Browser checks passed: desktop/mobile, login, session namespace, drafts, waveform migration and translation activity states.',
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
