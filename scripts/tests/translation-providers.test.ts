import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { test, after } from 'node:test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-foundry-translation-providers-'));
process.env.DATA_DIR = root;
process.env.APP_MODE = 'personal';
const { config } = await import('../../config.js');
const { responseTranslation } = await import('../lib/response-translation.js');
const { translateWithCodex, codexStatus } = await import('../lib/codex-translation.js');
const { validateTranslationSettings, translationProviders } =
  await import('../lib/translation-providers.js');
const { claudeArgs } = await import('../lib/claude-translation.js');
const { editorialSource } = await import('../lib/editorial-subtitles.js');
after(() => fs.rm(root, { recursive: true, force: true }));

const source = '1\n00:00:01,000 --> 00:00:02,500\nMerhaba.\n';
const translated = source.replace('Merhaba.', 'Hello.');
const context = { title: 'Fixture', sourceLanguage: 'tr', targetLanguage: 'en' };
const fake = path.join(root, 'claude');
await fs.writeFile(
  fake,
  `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('status')) {
  console.log(JSON.stringify({loggedIn:true,authMethod:process.argv[1].endsWith('api-login') ? 'api_key' : 'claude.ai'}));
  process.exit(0);
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => input += c);
process.stdin.on('end', () => {
  fs.appendFileSync('calls.txt', 'request\\n');
  const settings = JSON.parse(args[args.indexOf('--settings')+1]);
  if (settings.forceLoginMethod !== 'claudeai' || !settings.disableAllHooks || args[args.indexOf('--tools')+1] !== '' || args.includes('--bare')) throw new Error('Unsafe CLI arguments');
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_BASE_URL || process.env.CLAUDE_CODE_USE_VERTEX) throw new Error('API routing leaked into subscription');
  const model = args[args.indexOf('--model')+1];
  if (model === 'slow') { setInterval(() => {}, 1000); return; }
  const payload = JSON.parse(input.trim().split('\\n').at(-1));
  let result = (payload.source_srt || '').replaceAll('Merhaba.', 'Hello.');
  if (model === 'editorial') result = JSON.stringify({version:1,cues:payload.runs.flatMap(r => r.anchors.map(a => ({parts:[{from:a[0],to:a[0],text:'Hello.'}],kind:'dialogue',action:'keep'})))});
  if (model === 'retimed') result = result.replace('00:00:01,000','00:00:01,001');
  console.log(JSON.stringify({type:'result',subtype:model === 'quota' ? 'error_during_execution' : 'success',is_error:model === 'quota',stop_reason:model === 'truncated' ? 'max_tokens' : 'end_turn',result,usage:{input_tokens:10,output_tokens:10}}));
});
`,
  { mode: 0o700 },
);

async function fixture(model = 'ok') {
  const workDir = await fs.mkdtemp(path.join(root, 'job-'));
  const input = path.join(workDir, 'source.srt'),
    output = path.join(workDir, 'output.srt');
  await fs.writeFile(input, source);
  return {
    input,
    output,
    options: {
      workDir,
      settings: {
        TRANSLATION_PROVIDER: 'claude-local',
        CLAUDE_BIN: fake,
        CODEX_MODEL: model,
        CODEX_TRANSLATION_TIMEOUT_MS: 3000,
      },
    },
  };
}

test('subscription choices come first and model IDs accept OpenRouter namespaces', () => {
  assert.deepEqual(
    translationProviders.slice(0, 3).map((p) => p.id),
    ['codex-local', 'claude-local', 'grok-local'],
  );
  validateTranslationSettings({
    ...config,
    TRANSLATION_PROVIDER: 'openrouter-api',
    CODEX_MODEL: 'vendor/model:free',
  });
  assert.throws(() => validateTranslationSettings({ ...config, TRANSLATION_PROVIDER: 'unknown' }));
  assert.throws(() => validateTranslationSettings({ ...config, CODEX_MODEL: 'model?key=secret' }));
  assert.ok(!claudeArgs('').includes('--bare'), 'bare mode disables subscription login');
});

test('Claude uses subscription auth, preserves timestamps, and reuses completed receipts', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('No API fallback permitted');
  });
  process.env.ANTHROPIC_API_KEY = 'test-api-key-must-not-reach-cli';
  process.env.ANTHROPIC_BASE_URL = 'https://invalid.example';
  process.env.CLAUDE_CODE_USE_VERTEX = '1';
  try {
    const f = await fixture();
    assert.equal((await codexStatus(f.options)).available, true);
    const result = await translateWithCodex(f.input, f.output, context, null, f.options);
    assert.equal(result.report.provider, 'claude-local');
    assert.equal(result.report.timestampsIdentical, true);
    assert.match(await fs.readFile(f.output, 'utf8'), /Hello\./);
    assert.equal(await fs.readFile(f.input, 'utf8'), source);
    await translateWithCodex(f.input, f.output, context, null, f.options);
    assert.equal(await fs.readFile(path.join(f.options.workDir, 'calls.txt'), 'utf8'), 'request\n');
    await assert.rejects(
      translateWithCodex(f.input, f.output, context, null, {
        ...f.options,
        settings: { ...f.options.settings, TRANSLATION_PROVIDER: 'openai-api' },
      }),
      /start a new job/,
    );
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CLAUDE_CODE_USE_VERTEX;
  }
});

test('Claude API-key login cannot enter the subscription route', async () => {
  const api = path.join(root, 'api-login');
  await fs.copyFile(fake, api);
  const f = await fixture();
  f.options.settings.CLAUDE_BIN = api;
  assert.equal((await codexStatus(f.options)).available, false);
  await assert.rejects(
    translateWithCodex(f.input, f.output, context, null, f.options),
    /subscription/,
  );
  await assert.rejects(fs.access(path.join(f.options.workDir, 'calls.txt')));
});

test('Claude editorial output uses the same source-anchor and paired-track validation', async () => {
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
  assert.ok(result.reviewSourceFile && result.reviewTargetFile);
});
for (const model of ['quota', 'retimed', 'slow', 'truncated'])
  test(`Claude ${model} cannot publish or fall back`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('No API fallback permitted');
    });
    const f = await fixture(model);
    if (model === 'slow') f.options.settings.CODEX_TRANSLATION_TIMEOUT_MS = 150;
    await assert.rejects(translateWithCodex(f.input, f.output, context, null, f.options));
    await assert.rejects(fs.access(f.output));
    assert.equal(await fs.readFile(path.join(f.options.workDir, 'calls.txt'), 'utf8'), 'request\n');
  });

function sse(events: unknown[]) {
  const bytes = new TextEncoder().encode(
    ': keepalive\r\n\r\n' +
      events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\r\n\r\n`).join(''),
  );
  // Deliberately split UTF-8 characters and CRLF delimiters across transport chunks.
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) return controller.close();
        controller.enqueue(bytes.slice(offset, offset + 7));
        offset = Math.min(bytes.length, offset + 7);
      },
    }),
  );
}
const cases = [
  {
    id: 'openai-api',
    key: 'OPENAI_API_KEY',
    host: 'api.openai.com',
    events: (text: string, bad = false) => [
      {
        type: bad ? 'response.incomplete' : 'response.completed',
        response: {
          status: 'completed',
          output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
          ],
          usage: { output_tokens: 10 },
        },
      },
    ],
  },
  {
    id: 'openrouter-api',
    key: 'OPENROUTER_API_KEY',
    host: 'openrouter.ai',
    events: (text: string, bad = false) => [
      { choices: [{ index: 0, delta: { content: text }, finish_reason: bad ? 'length' : 'stop' }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: bad ? 'length' : 'stop' }],
        usage: { completion_tokens: 10 },
      },
      '[DONE]',
    ],
  },
  {
    id: 'anthropic-api',
    key: 'ANTHROPIC_API_KEY',
    host: 'api.anthropic.com',
    events: (text: string, bad = false) => [
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text } },
      {
        type: 'message_delta',
        delta: { stop_reason: bad ? 'max_tokens' : 'end_turn' },
        usage: { output_tokens: 10 },
      },
      { type: 'message_stop' },
    ],
  },
  {
    id: 'gemini-api',
    key: 'GEMINI_API_KEY',
    host: 'generativelanguage.googleapis.com',
    events: (text: string, bad = false) => [
      {
        candidates: [
          {
            index: 0,
            content: { parts: [{ text: 'private reasoning', thought: true }, { text }] },
            finishReason: bad ? 'MAX_TOKENS' : 'STOP',
          },
        ],
        usageMetadata: { candidatesTokenCount: 10 },
      },
    ],
  },
];
cases.push({ ...cases[0], id: 'xai-api', key: 'XAI_API_KEY', host: 'api.x.ai' });
for (const provider of cases)
  test(`${provider.id} routes the selected key and rejects truncated or disconnected streams`, async (t) => {
    const secret = `fixture-${provider.id}`;
    process.env[provider.key] = secret;
    const settings = { ...config, TRANSLATION_PROVIDER: provider.id, CODEX_MODEL: 'vendor-model' };
    let calls = 0,
      bad = false,
      empty = false;
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      calls++;
      assert.equal(new URL(String(url)).hostname, provider.host);
      assert.ok(!String(url).includes(secret));
      assert.ok(
        Object.values(init!.headers!).includes(secret) ||
          Object.values(init!.headers!).includes(`Bearer ${secret}`),
      );
      assert.ok(!JSON.stringify(init!.body).includes(secret));
      assert.equal(init!.redirect, 'error');
      return sse(empty ? [] : provider.events(translated + 'İ', bad));
    });
    try {
      const result = await responseTranslation('full subtitle context', settings);
      assert.equal(result.text, translated + 'İ');
      assert.ok(result.usage);
      bad = true;
      await assert.rejects(responseTranslation('context', settings));
      empty = true;
      await assert.rejects(responseTranslation('context', settings), /before completion/);
      assert.equal(calls, 3, 'No automatic retry');
    } finally {
      delete process.env[provider.key];
    }
  });

test('API cancellation and HTTP failures are bounded and never retried', async (t) => {
  process.env.OPENROUTER_API_KEY = 'fixture-router';
  const settings = {
    ...config,
    TRANSLATION_PROVIDER: 'openrouter-api',
    CODEX_MODEL: 'vendor/model',
  };
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    init!.signal!.throwIfAborted();
    return new Response('', { status: 429 });
  });
  try {
    await assert.rejects(responseTranslation('context', settings), /HTTP 429/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(responseTranslation('context', settings, controller.signal), {
      name: 'AbortError',
    });
    assert.equal(calls, 2);
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});
