import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test, after } from 'node:test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-foundry-grok-test-'));
process.env.DATA_DIR = root;
process.env.APP_MODE = 'personal';
process.env.GROK_AUTH_PATH = path.join(root, 'auth.json');
await fs.writeFile(process.env.GROK_AUTH_PATH, '{}', { mode: 0o600 });
const { config } = await import('../../config.js');
const { translateWithCodex, codexStatus } = await import('../lib/codex-translation.js');
const { childEnvironment } = await import('../lib/process.js');
const { editorialSource } = await import('../lib/editorial-subtitles.js');
after(() => fs.rm(root, { recursive: true, force: true }));

const source = '1\n00:00:01,000 --> 00:00:02,500\nMerhaba.\n';
const context = { title: 'Fixture', sourceLanguage: 'tr', targetLanguage: 'en' };
async function fixture(model = 'ok') {
  const workDir = await fs.mkdtemp(path.join(root, 'job-'));
  const input = path.join(workDir, 'source.srt');
  const output = path.join(workDir, 'output.srt');
  const callFile = path.join(workDir, 'calls.txt');
  const runtimeFile = path.join(workDir, 'runtime.txt');
  const cli = path.join(workDir, 'grok');
  await fs.writeFile(input, source);
  await fs.writeFile(
    cli,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (process.env.GROK_DISABLE_API_KEY_AUTH !== '1' || process.env.XAI_API_KEY || process.env.GROK_AUTH || process.env.GROK_BASE_URL || process.env.GROK_AUTH_PROVIDER_COMMAND) throw new Error('Unsafe authentication environment');
if (process.env.GROK_HOME !== process.cwd() || process.env.GROK_CLAUDE_HOOKS_ENABLED !== '0' || process.env.GROK_CURSOR_MCPS_ENABLED !== '0') throw new Error('Unsafe runtime');
const cfg = fs.readFileSync(path.join(process.cwd(),'config.toml'),'utf8');
if (!cfg.includes('preferred_method = "oidc"') || !cfg.includes('max_retries = 0') || !cfg.includes('use_leader = false')) throw new Error('Unsafe configuration');
fs.writeFileSync(${JSON.stringify(runtimeFile)}, process.cwd());
if (args.includes('inspect')) {
 const disabled = cfg.includes('disabled = ["fixture-plugin"]');
 console.log(JSON.stringify({grokVersion:'fixture',loginPolicy:{apiKeyAuthDisabled:${model !== 'old-cli'}},plugins:[{name:'fixture-plugin',enabled:true}],hooks:${model === 'policy-hooks'} ? [{disabled:false}] : disabled ? [] : [{disabled:false}],mcpServers:[],lspServers:[]}));
 process.exit(0);
}
if (!cfg.includes('disabled = ["fixture-plugin"]') || args[args.indexOf('--tools')+1] !== '' || args[args.indexOf('--deny')+1] !== '*' || args[args.indexOf('--permission-mode')+1] !== 'dontAsk' || !args.includes('--no-subagents') || !args.includes('--disable-web-search')) throw new Error('Unsafe tools');
fs.appendFileSync(${JSON.stringify(callFile)}, 'request\\n');
const model = args[args.indexOf('--model')+1];
if (model === 'slow') { setInterval(()=>{},1000); return; }
if (model === 'quota' || model === 'api-login') { console.error('Sign in with browser login or check allowance'); process.exit(1); }
const prompt=fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8');
const payload=JSON.parse(prompt.trim().split('\\n').at(-1));
let text=(payload.source_srt || '').replaceAll('Merhaba.', 'Hello.');
if (model === 'editorial') text=JSON.stringify({version:1,cues:payload.runs.flatMap(r=>r.anchors.map(a=>({parts:[{from:a[0],to:a[0],text:'Hello.'}],kind:'dialogue',action:'keep'})))});
if (model === 'retimed') text=text.replace('00:00:01,000','00:00:01,001');
console.log(JSON.stringify({text,stopReason:model === 'truncated' ? 'max_tokens' : 'end_turn',thought:'not subtitle content',usage:{input_tokens:10,output_tokens:10}}));
`,
    { mode: 0o700 },
  );
  return {
    input,
    output,
    callFile,
    runtimeFile,
    options: {
      workDir,
      settings: {
        ...config,
        TRANSLATION_PROVIDER: 'grok-local',
        GROK_BIN: cli,
        CODEX_MODEL: model,
        CODEX_TRANSLATION_TIMEOUT_MS: model === 'slow' ? 150 : 3000,
      },
    },
  };
}

test('child environment retains only the restrictive Grok auth switch and strips real secrets', () => {
  const env = childEnvironment({
    GROK_DISABLE_API_KEY_AUTH: '1',
    XAI_API_KEY: 'fixture',
    GROK_AUTH_TOKEN: 'fixture',
  });
  assert.equal(env.GROK_DISABLE_API_KEY_AUTH, '1');
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.GROK_AUTH_TOKEN, undefined);
  assert.equal(
    childEnvironment({ GROK_DISABLE_API_KEY_AUTH: '0' }).GROK_DISABLE_API_KEY_AUTH,
    undefined,
  );
});

test('Grok uses browser login without API overrides, validates timing, and reuses receipts', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('No API fallback permitted');
  });
  const overrides = {
    XAI_API_KEY: 'fixture',
    GROK_AUTH: 'fixture',
    GROK_BASE_URL: 'https://invalid.example',
    GROK_AUTH_PROVIDER_COMMAND: 'must-not-run',
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]));
  Object.assign(process.env, overrides);
  try {
    const f = await fixture();
    assert.equal((await codexStatus(f.options)).available, true);
    const result = await translateWithCodex(f.input, f.output, context, null, f.options);
    assert.equal(result.report.provider, 'grok-local');
    assert.equal(result.report.timestampsIdentical, true);
    assert.equal(
      (await fs.readFile(f.output, 'utf8')).replace(/^\uFEFF/, '').replaceAll('\r\n', '\n'),
      source.replace('Merhaba.', 'Hello.'),
    );
    assert.equal(await fs.readFile(f.input, 'utf8'), source);
    await translateWithCodex(f.input, f.output, context, null, f.options);
    assert.equal(await fs.readFile(f.callFile, 'utf8'), 'request\n');
    await assert.rejects(fs.access(await fs.readFile(f.runtimeFile, 'utf8')));
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('Grok editorial output passes the shared source-anchor validation', async () => {
  const f = await fixture('editorial');
  const result = await translateWithCodex(
    f.input,
    f.output,
    { ...context, editorial: editorialSource(source) },
    null,
    f.options,
  );
  assert.equal(result.report.mode, 'editorial');
  assert.equal(result.report.editorial?.coveredAnchors, 1);
});

for (const model of ['old-cli', 'policy-hooks'])
  test(`Grok ${model} is rejected before inference`, async () => {
    const f = await fixture(model);
    assert.equal((await codexStatus(f.options)).available, false);
    await assert.rejects(translateWithCodex(f.input, f.output, context, null, f.options));
    await assert.rejects(fs.access(f.callFile));
  });
for (const model of ['quota', 'api-login', 'truncated', 'retimed', 'slow'])
  test(`Grok ${model} cannot publish or fall back`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('No API fallback permitted');
    });
    const f = await fixture(model);
    await assert.rejects(translateWithCodex(f.input, f.output, context, null, f.options));
    await assert.rejects(fs.access(f.output));
    assert.equal(await fs.readFile(f.callFile, 'utf8'), 'request\n');
    await assert.rejects(fs.access(await fs.readFile(f.runtimeFile, 'utf8')));
  });
test('Grok cancellation removes the temporary prompt and session', async () => {
  const f = await fixture('slow');
  f.options.settings.CODEX_TRANSLATION_TIMEOUT_MS = 3000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  try {
    await assert.rejects(
      translateWithCodex(f.input, f.output, context, null, {
        ...f.options,
        signal: controller.signal,
      }),
      { name: 'AbortError' },
    );
    await assert.rejects(fs.access(f.output));
    await assert.rejects(fs.access(await fs.readFile(f.runtimeFile, 'utf8')));
  } finally {
    clearTimeout(timer);
  }
});
