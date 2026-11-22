import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TranslationFailure,
  translationFailureKind,
  withTranslationRetries,
} from '../lib/translation-retry.js';
import type { TranslationRetryState } from '../../public/translation-activity.js';

const defaults = { enabled: true, maximum: 3, delayMs: 1, onState: async () => {} };

test('temporary errors are distinguished from login, quota and source failures', () => {
  for (const [message, kind] of [
    ['codex exceeded its 1800s deadline', 'timeout'],
    ['The operation was aborted due to timeout', 'timeout'],
    [
      'Translation provider returned HTTP 503. Check your connection and allowance; retry manually.',
      'connection',
    ],
    [
      'Translation provider returned HTTP 429. Check your connection and allowance; retry manually.',
      'connection',
    ],
    ['socket ECONNRESET', 'connection'],
    ['Translation stream ended before completion.', 'connection'],
    ['Codex did not complete the translation', 'response'],
    ['429 usage limit exceeded', 'quota'],
    ['insufficient_quota', 'quota'],
    ['HTTP 401 unauthorized', 'auth'],
    ['Source subtitles changed during translation', 'other'],
    ['Translation was refused', 'other'],
  ])
    assert.equal(translationFailureKind(message), kind, message);
});

test('retries are reserved before requests and stop at the configured budget', async () => {
  const attempts: number[] = [],
    states: TranslationRetryState[] = [];
  await assert.rejects(
    withTranslationRetries(
      async (attempt) => {
        attempts.push(attempt);
        if (attempt) assert.equal(states.at(-1)?.nextAt, null);
        throw new TranslationFailure('No complete output', 'response');
      },
      {
        ...defaults,
        onState: async (state) => {
          states.push(structuredClone(state));
        },
      },
    ),
    /exhausted \(3\/3\)/,
  );
  assert.deepEqual(attempts, [0, 1, 2, 3]);
  assert.deepEqual(
    states.filter((s) => s.nextAt).map((s) => s.attempt),
    [1, 2, 3],
  );
});

test('saved retry budget survives restart and successful recovery stops retrying', async () => {
  const attempts: number[] = [];
  const result = await withTranslationRetries(
    async (attempt) => {
      attempts.push(attempt);
      if (attempt === 2) throw new TranslationFailure('Invalid subtitles', 'validation');
      return 'saved';
    },
    {
      ...defaults,
      initial: {
        attempt: 2,
        maximum: 3,
        nextAt: new Date(0).toISOString(),
        reason: 'the request timed out',
      },
    },
  );
  assert.equal(result, 'saved');
  assert.deepEqual(attempts, [2, 3]);
});

test('cancellation during backoff prevents another request', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(
    withTranslationRetries(
      async () => {
        calls++;
        throw new TranslationFailure('Temporary failure', 'connection');
      },
      {
        ...defaults,
        delayMs: 10000,
        signal: controller.signal,
        onState: async () => {
          controller.abort();
        },
      },
    ),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});

test('permanent errors, disabled retries and recovery-only operations never resubmit', async () => {
  for (const [error, options] of [
    [new TranslationFailure('Sign in', 'auth'), {}],
    [new TranslationFailure('Usage exhausted', 'quota'), {}],
    [new Error('Source changed'), {}],
    [new TranslationFailure('Timeout', 'timeout'), { maximum: 0 }],
    [new TranslationFailure('Invalid output', 'validation'), { enabled: false }],
  ] as const) {
    let calls = 0;
    await assert.rejects(
      withTranslationRetries(
        async () => {
          calls++;
          throw error;
        },
        { ...defaults, ...options },
      ),
    );
    assert.equal(calls, 1);
  }
});
