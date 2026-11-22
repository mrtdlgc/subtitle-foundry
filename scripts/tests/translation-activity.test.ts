import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TranslationActivityTracker,
  translationActivityView,
  legacyTranslationActivity,
  responseActivityEvent,
  TRANSLATION_QUIET_MS,
} from '../../public/translation-activity.js';

test('heartbeats and connection chatter cannot masquerade as translation progress', () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const tracker = new TranslationActivityTracker('Section 3/16', 1800000, 'events', () => now);
  assert.equal(translationActivityView(tracker.snapshot(), now).state, 'waiting');
  for (let i = 0; i < 20; i++) {
    now += 15000;
    tracker.data(32);
    tracker.event({ type: 'ping' });
    tracker.event({ type: 'turn.started' });
    tracker.event({ type: 'response.in_progress' });
    tracker.snapshot();
  }
  const view = translationActivityView(tracker.snapshot(), now);
  assert.equal(view.state, 'possibly-stalled');
  assert.equal(tracker.snapshot().responseEvents, 0);
  assert.equal(view.quiet, TRANSLATION_QUIET_MS);
  assert.match(view.note, /Messages are arriving/);
  tracker.event({
    type: 'item.updated',
    item: { type: 'agent_message', text: 'private dialogue' },
  });
  assert.equal(translationActivityView(tracker.snapshot(), now).state, 'responding');
  assert.equal(tracker.snapshot().responseEvents, 1);
  assert.doesNotMatch(JSON.stringify(tracker.snapshot()), /private dialogue/);
  now += TRANSLATION_QUIET_MS;
  assert.equal(translationActivityView(tracker.snapshot(), now).state, 'possibly-stalled');
});

test('response signals cover CLI and API output while empty deltas and start events do not', () => {
  for (const event of [
    { type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning' } },
    { type: 'response.output_text.delta', delta: 'hello' },
    { type: 'response.reasoning_summary_text.delta', delta: 'progress' },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
    { choices: [{ delta: { content: 'hello' } }] },
    { candidates: [{ content: { parts: [{ text: 'hello' }] } }] },
  ])
    assert.equal(responseActivityEvent(event), true);
  for (const event of [
    null,
    { type: 'thread.started' },
    { type: 'response.created' },
    { type: 'response.output_text.delta', delta: '' },
    { type: 'ping' },
    { type: 'item.started', item: { type: 'agent_message', text: '' } },
    { type: 'response.completed', response: { status: 'failed' } },
  ])
    assert.equal(responseActivityEvent(event), false);
});

test('retry notices, stale monitoring and completion-only providers remain explicit', () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const tracker = new TranslationActivityTracker('Section 3/16', 1800000, 'events', () => now);
  now += 1000;
  tracker.diagnostic('stream disconnected; reconnecting, secret=do-not-store');
  assert.equal(translationActivityView(tracker.snapshot(), now).state, 'reconnecting');
  assert.doesNotMatch(JSON.stringify(tracker.snapshot()), /secret|do-not-store/);
  const saved = tracker.snapshot();
  now += 46000;
  assert.equal(translationActivityView(saved, now).state, 'unavailable');
  const buffered = new TranslationActivityTracker(
    'Complete subtitle file',
    1800000,
    'completion-only',
    () => now,
  );
  now += TRANSLATION_QUIET_MS;
  assert.match(translationActivityView(buffered.snapshot(), now).note, /finished replies only/);
});

test('a new section resets its timer without inheriting previous response activity', () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const first = new TranslationActivityTracker('Section 1/2', 1800000, 'events', () => now);
  first.response();
  now += 100000;
  const second = new TranslationActivityTracker('Section 2/2', 1800000, 'events', () => now);
  assert.equal(second.snapshot().lastResponseAt, null);
  assert.equal(translationActivityView(second.snapshot(), now).elapsed, 0);
  assert.equal(translationActivityView(second.snapshot(), now).state, 'waiting');
});

test('legacy running timers expose lack of telemetry without inventing provider activity', () => {
  const updated = '2026-01-01T00:00:00Z';
  const view = legacyTranslationActivity(
    'Translation is running on section 3/16 · 1440s elapsed',
    updated,
    Date.parse(updated) + 15000,
  )!;
  assert.equal(view.state, 'possibly-stalled');
  assert.match(view.detail, /24m 15s/);
  assert.match(view.note, /was not recorded/);
  assert.equal(legacyTranslationActivity('Translation saved'), null);
});
