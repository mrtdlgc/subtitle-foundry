// Compatibility with existing browser drafts, playback state and prepared media.
// New writes use Subtitle Foundry names. Old identifiers are kept only for recovery.
const legacyPrefix = 'yesilcam';
export const legacyWaveformDatabase = `${legacyPrefix}-local-waveforms`;

export function reviewStorageKey(suffix: string, storage: Storage = localStorage): string {
  const key = `subtitle-foundry-${suffix}`;
  const previous = `${legacyPrefix}-${suffix}`;
  try {
    if (storage.getItem(key) === null) {
      const value = storage.getItem(previous);
      if (value !== null) {
        try {
          // Never discard the only copy if storage is full or unavailable.
          storage.setItem(key, value);
        } catch {
          return previous;
        }
      }
    }
    // Once migrated, clearing a draft must not resurrect its older copy.
    storage.removeItem(previous);
  } catch {
    // Callers already handle unavailable browser storage without blocking review.
  }
  return key;
}

export function matchesPreparedMediaTag(comment: unknown, fingerprint: string): boolean {
  return (
    comment === `subtitle-foundry-local:${fingerprint}` ||
    comment === `${legacyPrefix}-local:${fingerprint}`
  );
}
