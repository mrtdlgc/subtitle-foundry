import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesPreparedMediaTag, reviewStorageKey } from '../../public/storage-compat.js';

function storage(values: Record<string, string> = {}): Storage {
  const entries = new Map(Object.entries(values));
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    key: (index) => Array.from(entries.keys())[index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

test('existing correction drafts and playback notes survive the rename without resurrecting discarded edits', () => {
  const fixtures = [
    [
      'corrections-v2:/studio/:film-7',
      '{"edits":[{"id":"cue-2","texts":{"en":"A corrected line."}}]}',
    ],
    [
      'review-v1:film-7:abc123',
      '{"position":123.5,"notes":{"cue-2":{"text":"Check the name","flagged":true}}}',
    ],
  ];
  for (const [suffix, value] of fixtures) {
    const old = `yesilcam-${suffix}`;
    const saved = storage({ [old]: value });
    const key = reviewStorageKey(suffix, saved);
    assert.equal(key, `subtitle-foundry-${suffix}`);
    assert.equal(saved.getItem(key), value);
    assert.equal(saved.getItem(old), null);
    saved.removeItem(key);
    reviewStorageKey(suffix, saved);
    assert.equal(saved.getItem(key), null);
  }
});

test('newer drafts take precedence and a failed migration retains the only saved copy', () => {
  const suffix = 'corrections-v2:/:film-7';
  const old = `yesilcam-${suffix}`,
    current = `subtitle-foundry-${suffix}`;
  const saved = storage({ [old]: 'old draft', [current]: 'new draft' });
  assert.equal(reviewStorageKey(suffix, saved), current);
  assert.equal(saved.getItem(current), 'new draft');
  assert.equal(saved.getItem(old), null);
  const full = storage({ [old]: 'unsent edits' });
  full.setItem = () => {
    throw new Error('Quota exceeded');
  };
  assert.equal(reviewStorageKey(suffix, full), old);
  assert.equal(full.getItem(old), 'unsent edits');
});

test('previously prepared screening copies still match only their original source fingerprint', () => {
  assert.ok(matchesPreparedMediaTag('yesilcam-local:source-a', 'source-a'));
  assert.ok(matchesPreparedMediaTag('subtitle-foundry-local:source-a', 'source-a'));
  assert.equal(matchesPreparedMediaTag('yesilcam-local:source-a', 'source-b'), false);
  assert.equal(matchesPreparedMediaTag('subtitle-foundry-local:source-a', 'source-b'), false);
  assert.equal(matchesPreparedMediaTag(undefined, 'source-a'), false);
});
