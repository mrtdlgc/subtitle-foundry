import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { after, test } from 'node:test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-youtube-'));
process.env.DATA_DIR = root;
process.env.APP_MODE = 'personal';
delete process.env.YOUTUBE_BROWSER;
delete process.env.YOUTUBE_COOKIES;
delete process.env.CREDENTIALS_MASTER_KEY;
const fixture = path.join(root, 'downloader.cjs');
process.env.YTDLP_BIN = fixture;
await fs.writeFile(
  fixture,
  `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.FIXTURE_ERROR) {
  console.error(process.env.FIXTURE_ERROR);
  process.exit(1);
}
const file = args.includes('--cookies') ? args[args.indexOf('--cookies') + 1] : null;
console.log(JSON.stringify({ args, file, cookieMode: file ? fs.statSync(file).mode & 0o777 : null,
  cookieContent: file ? fs.readFileSync(file, 'utf8') : null }));
`,
  { mode: 0o700 },
);
after(() => fs.rm(root, { recursive: true, force: true }));
const { saveCredential, clearCredential, credentialStatus, validateYouTubeBrowser } =
  await import('../lib/credentials.js');
const { youtube } = await import('../lib/youtube.js');
const { run } = await import('../lib/process.js');
const args = [
  '--skip-download',
  '--dump-single-json',
  '--',
  'https://www.youtube.com/watch?v=abcdefghijk',
];
const invoke = async () => JSON.parse((await youtube(args)).stdout);
const cookie = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tfixture-only';

test('browser selection refreshes per request, overrides exports without writing a cookie jar, and can be cleared', async () => {
  let result = await invoke();
  assert.ok(!result.args.includes('--cookies-from-browser'));
  assert.equal(result.file, null);

  await saveCredential('YOUTUBE_COOKIES', cookie);
  result = await invoke();
  assert.equal(result.cookieContent, cookie + '\n');
  assert.equal(result.cookieMode, 0o600);
  await assert.rejects(fs.stat(result.file), { code: 'ENOENT' });

  for (const browser of ['chrome:Profile 1', 'firefox::Work']) {
    await saveCredential('YOUTUBE_BROWSER', browser);
    result = await invoke();
    assert.equal(result.args[result.args.indexOf('--cookies-from-browser') + 1], browser);
    assert.deepEqual(result.args.slice(-args.length), args);
    assert.ok(!result.args.includes('--cookies'));
    assert.equal(result.file, null);
    assert.ok(
      !(await fs.readdir(path.join(root, 'data/private'))).some((name) =>
        name.startsWith('youtube-'),
      ),
    );
    const fields = await credentialStatus();
    assert.equal(fields.find((field) => field.name === 'YOUTUBE_BROWSER')!.value, browser);
    assert.equal(fields.find((field) => field.name === 'YOUTUBE_COOKIES')!.value, undefined);
  }

  process.env.YOUTUBE_BROWSER = 'edge';
  await clearCredential('YOUTUBE_BROWSER');
  result = await invoke();
  assert.ok(
    !result.args.includes('--cookies-from-browser'),
    'Clear masks an environment setting too',
  );
  assert.equal(result.cookieContent, cookie + '\n');
  delete process.env.YOUTUBE_BROWSER;
  await clearCredential('YOUTUBE_COOKIES');
  assert.equal((await invoke()).file, null);
});

test('browser settings reject malformed names, flags and control characters', async () => {
  for (const value of [
    'chrome',
    'chrome+gnomekeyring:Default',
    'firefox:/tmp/profile with spaces',
    'firefox::Work',
  ])
    assert.equal(validateYouTubeBrowser(value), value);
  for (const value of [
    'unknown',
    '--cookies /tmp/file',
    'chrome --exec command',
    'chrome:',
    'chrome+unknown',
    'chrome:Default\n--exec command',
    'chrome:' + 'a'.repeat(1024),
  ]) {
    assert.throws(() => validateYouTubeBrowser(value), { status: 400 });
    await assert.rejects(saveCredential('YOUTUBE_BROWSER', value), { status: 400 });
  }
});

test('browser and export failures provide recovery advice and clean temporary cookies', async () => {
  await saveCredential('YOUTUBE_BROWSER', 'chrome');
  await assert.rejects(
    youtube(args, { env: { FIXTURE_ERROR: 'Could not find chrome cookies database' } }),
    /same desktop user/,
  );
  await assert.rejects(
    youtube(args, { env: { FIXTURE_ERROR: "Sign in to confirm you're not a bot" } }),
    /selected browser session/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(youtube(args, { signal: controller.signal }), { name: 'AbortError' });
  await clearCredential('YOUTUBE_BROWSER');
  await saveCredential('YOUTUBE_COOKIES', cookie);
  await assert.rejects(
    youtube(args, { env: { FIXTURE_ERROR: 'HTTP Error 403' } }),
    /YouTube browser session/,
  );
  assert.ok(
    !(await fs.readdir(path.join(root, 'data/private'))).some((name) =>
      name.startsWith('youtube-'),
    ),
  );
  await clearCredential('YOUTUBE_COOKIES');
});

test('hosted downloader never inherits the server operator browser selection', async () => {
  const result = await run(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    const { youtube } = await import('./scripts/lib/youtube.ts');
    process.stdout.write((await youtube(${JSON.stringify(args)})).stdout);
  `,
    ],
    { env: { APP_MODE: 'hosted', YOUTUBE_BROWSER: 'chrome+gnomekeyring:Default' } },
  );
  const actual = JSON.parse(result.stdout);
  assert.ok(!actual.args.includes('--cookies-from-browser'));
  assert.equal(actual.file, null);
});
