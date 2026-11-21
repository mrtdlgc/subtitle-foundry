import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, test } from 'node:test';
import type { Job, QueueState } from '../../types/pipeline.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-foundry-queue-'));
process.env.DATA_DIR = root;
const { config } = await import('../../config.js');
const { nextQueuedJob, jobPhase } = await import('../lib/queue.js');
const { run, childEnvironment } = await import('../lib/process.js');
const { writeJson, readJson, at } = await import('../lib/files.js');
const { runPipeline } = await import('../pipeline.js');
after(() => fs.rm(root, { recursive: true, force: true }));

function job(id: string, extra: Partial<Job> = {}): Job {
  return {
    id,
    title: id,
    type: 'audio',
    status: 'queued',
    progress: 0,
    createdAt: new Date().toISOString(),
    logs: [],
    settings: config,
    ...extra,
  };
}
function queue(jobs: Job[]): QueueState {
  return {
    version: 1,
    jobs,
    processed: {},
    control: {
      paused: false,
      scannerEnabled: false,
      reason: null,
      updatedAt: '',
    },
  };
}

test('preparation skips waiting translations while the translation worker is busy', () => {
  const state = queue([job('ready', { pipelinePhase: 'translation' }), job('next'), job('later')]);
  assert.equal(nextQueuedJob(state, new Set(['translation']))?.id, 'next');
  assert.equal(nextQueuedJob(state, new Set(['transcription']))?.id, 'ready');
  assert.equal(nextQueuedJob(state, new Set(['transcription', 'translation'])), undefined);
  assert.equal(jobPhase(job('srt', { type: 'translation' })), 'translation');
  assert.equal(
    nextQueuedJob(queue([state.jobs[0]]), new Set(['transcription']), false, new Set(['ready'])),
    undefined,
    'a published handoff cannot be claimed until its previous worker releases the job',
  );
});

test('pause and eligibility apply to both workers, including hosted ownership', () => {
  const state = queue([job('legacy'), job('owned', { ownerId: 'account' })]);
  assert.equal(nextQueuedJob(state, new Set(), true)?.id, 'owned');
  state.jobs[1].status = 'processing';
  assert.equal(nextQueuedJob(state, new Set(), true), undefined);
  state.control!.paused = true;
  assert.equal(nextQueuedJob(state, new Set()), undefined);
});

test(
  'transcripts advance during translation, survive restart, and never repeat paid ASR',
  { timeout: 45000 },
  async () => {
    const fake = path.join(root, 'codex');
    const marker = path.join(root, 'translation-starts');
    const release = path.join(root, 'allow-translation');
    await fs.writeFile(
      fake,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
if (args.includes('status')) { console.error('Logged in using ChatGPT'); process.exit(0); }
let input = '';
process.stdin.on('data', data => input += data);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(marker)}, process.cwd() + '\\n');
  const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(release)})) return;
    clearInterval(timer);
    const source = JSON.parse(input.split('\\n').at(-1)).source_srt;
    fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], source.replaceAll('Merhaba.', 'Hello.'));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:10}}));
  }, 20);
});
`,
      { mode: 0o700 },
    );
    let posts = 0;
    const provider = http.createServer((req, res) => {
      posts++;
      req.resume();
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            text: 'Merhaba.',
            language: 'tr',
            words: [{ word: 'Merhaba.', start: 0.1, end: 0.9 }],
          }),
        );
      });
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const endpoint = `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}/transcribe`;
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`;
    const settings = {
      ...config,
      DEFAULT_LANGUAGE: 'tr',
      TARGET_LANGUAGE: 'en',
      TRANSCRIBE_BACKEND: 'compatible',
      TRANSCRIPTION_MODEL: 'fixture',
      TRANSCRIPTION_MODE: 'chunks',
      CLOUD_PRICE_PER_MINUTE: 0.01,
      CLOUD_MAX_ESTIMATED_COST: 1,
      TRANSLATION_ENABLED: true,
      TRANSLATION_PROVIDER: 'codex-local',
      TRANSLATION_MODE: 'fixed',
      CODEX_BIN: fake,
      CODEX_MODEL: '',
      PREPARE_REVIEW: false,
      ALIGN_TO_SPEECH: false,
      FILTER_HALLUCINATIONS: false,
      SILERO_VAD_ENABLED: false,
      PAUSE_BEFORE_TRANSCRIPTION: false,
      PAUSE_AFTER_DEMUCS: false,
      DEMUCS_ENABLED: false,
      KEEP_INTERMEDIATES: true,
      LOCAL_AUDIO_ENABLED: false,
    };
    const audio = path.join(root, 'fixture.wav');
    await run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=500:duration=1',
      '-c:a',
      'pcm_s16le',
      audio,
    ]);
    const jobs = ['first', 'second', 'third'].map((id) =>
      job(id, {
        input: at('temp', id, 'source.wav'),
        settings,
      }),
    );
    for (const item of jobs) {
      await fs.mkdir(path.dirname(item.input!), { recursive: true });
      await fs.copyFile(audio, item.input!);
    }
    const queueFile = at('data', 'processing-queue.json');
    await writeJson(queueFile, queue(jobs));
    let logs = '';
    const start = () => {
      const server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
        cwd: path.resolve(import.meta.dirname, '../..'),
        env: {
          ...childEnvironment(),
          DATA_DIR: root,
          APP_PASSWORD: 'isolated-test-password',
          PORT: String(port),
          PUBLIC_ORIGIN: base,
          TRANSCRIPTION_API_URL: endpoint,
          CODEX_BIN: fake,
          LOCAL_AUDIO_ENABLED: 'false',
          SHUTDOWN_GRACE_MS: '5000',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      server.stdout.on('data', (data) => {
        logs += data;
      });
      server.stderr.on('data', (data) => {
        logs += data;
      });
      return server;
    };
    let server = start();
    const waitFor = async (condition: () => Promise<boolean>) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (await condition()) return;
        if (server.exitCode !== null) throw new Error(logs);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`Timed out: ${logs}\n${JSON.stringify(await readJson(queueFile))}`);
    };
    let cookie = '';
    const request = async (url: string, body?: unknown) => {
      const response = await fetch(base + url, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: base,
          'X-Subtitle-Foundry-Request': '1',
          Cookie: cookie,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.ok, true, await response.clone().text());
      if (url === '/api/auth/login') cookie = response.headers.get('set-cookie')!.split(';')[0];
      return response.json();
    };
    const login = async () => {
      await waitFor(async () =>
        fetch(base + '/health').then(
          (r) => r.ok,
          () => false,
        ),
      );
      await request('/api/auth/login', { password: 'isolated-test-password' });
    };
    try {
      await login();
      await waitFor(async () => {
        const state = await readJson<QueueState>(queueFile);
        return (
          state.jobs[0].status === 'processing' &&
          state.jobs
            .slice(1)
            .every((item) => item.status === 'queued' && item.pipelinePhase === 'translation')
        );
      });
      assert.equal(posts, 3, 'all three films transcribe while the first translation is blocked');
      assert.equal(
        (await fs.readFile(marker, 'utf8')).trim().split('\n').length,
        1,
        'translation requests remain sequential',
      );
      const status = await request('/api/status');
      assert.deepEqual(
        status.queue.activeJobs.map((item: any) => item.phase),
        ['translation'],
      );
      assert.equal(status.queue.pendingJobs, 2);
      await request('/api/queue/control', { paused: true });
      await fs.writeFile(release, 'release');
      await waitFor(
        async () => (await readJson<QueueState>(queueFile)).jobs[0].status === 'completed',
      );
      assert.equal(
        (await fs.readFile(marker, 'utf8')).trim().split('\n').length,
        1,
        'pause prevents waiting translations from starting',
      );
      const exit = once(server, 'exit');
      server.kill('SIGTERM');
      assert.equal((await exit)[0], 0, logs);

      const manifest = await readJson(at('temp', 'second', 'manifest.json'));
      assert.equal(manifest.stage, 'translation-ready');
      const sourceFile = at('output', 'subtitles', 'second_second_tr.srt');
      const source = await fs.readFile(sourceFile, 'utf8');
      await fs.writeFile(sourceFile, source.replace('Merhaba.', 'Changed.'));
      await assert.rejects(runPipeline(jobs[1]), /Saved transcript changed before translation/);
      await fs.writeFile(sourceFile, source);
      server = start();
      await login();
      await request('/api/queue/control', { paused: false });
      await waitFor(async () =>
        (await readJson<QueueState>(queueFile)).jobs.every((item) => item.status === 'completed'),
      );
      assert.equal(posts, 3, 'restart must not submit any transcript again');
      assert.equal((await fs.readFile(marker, 'utf8')).trim().split('\n').length, 3);
      for (const item of jobs) {
        assert.match(
          await fs.readFile(at('output', 'subtitles', `${item.id}_${item.id}_en.srt`), 'utf8'),
          /Hello\./,
        );
        const receipt = await readJson(
          at('output', 'raw_transcriptions', item.id, 'chunk_0.request.json'),
        );
        assert.equal(receipt.attempts, 1);
      }
    } finally {
      if (server.exitCode === null) {
        const exit = once(server, 'exit');
        server.kill('SIGTERM');
        await exit;
      }
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  },
);
