export const TRANSLATION_QUIET_MS = 5 * 60 * 1000;
export interface TranslationRetryState {
  attempt: number;
  maximum: number;
  nextAt: string | null;
  reason: string;
}

export function translationRetryView(retry: TranslationRetryState, now = Date.now()) {
  const remaining = Math.max(0, Date.parse(retry.nextAt ?? '') - now);
  return {
    state: 'retrying',
    label: `Automatic retry ${retry.attempt}/${retry.maximum}`,
    detail: `${retry.nextAt ? `Retrying in ${activityDuration(remaining)}` : 'Retrying now'} because ${retry.reason}.`,
    note: 'Completed sections are saved and will be reused. Transcription is not repeated.',
  };
}
const RECENT_MS = 90 * 1000;

export interface TranslationActivity {
  startedAt: string;
  observedAt: string;
  lastDataAt: string | null;
  lastResponseAt: string | null;
  lastRetryAt: string | null;
  responseEvents: number;
  receivedBytes: number;
  timeoutMs: number;
  visibility: 'events' | 'completion-only';
  scope: string;
}

const nonempty = (value: unknown) => typeof value === 'string' && value.length > 0;

// Count response evidence, never timer ticks, start acknowledgements or SSE pings.
// Neither payload text nor reasoning is retained in the activity record.
export function responseActivityEvent(value: any): boolean {
  if (!value || typeof value !== 'object') return false;
  if (
    ['item.updated', 'item.completed'].includes(value.type) &&
    ['agent_message', 'reasoning'].includes(value.item?.type)
  )
    return nonempty(value.item.text);
  if (/^response\.(?:output_text|reasoning(?:_summary)?_text)\.delta$/.test(value.type ?? ''))
    return nonempty(value.delta);
  if (value.type === 'content_block_delta')
    return nonempty(value.delta?.text) || nonempty(value.delta?.thinking);
  if (value.type === 'content_block_start') return nonempty(value.content_block?.text);
  if (Array.isArray(value.choices))
    return value.choices.some(
      (choice: any) => nonempty(choice.delta?.content) || nonempty(choice.delta?.reasoning),
    );
  if (Array.isArray(value.candidates))
    return value.candidates.some((candidate: any) =>
      candidate.content?.parts?.some((part: any) => nonempty(part.text)),
    );
  return (
    value.type === 'turn.completed' ||
    (value.type === 'response.completed' && value.response?.status === 'completed')
  );
}

export class TranslationActivityTracker {
  private value: TranslationActivity;
  constructor(
    scope: string,
    timeoutMs: number,
    visibility: TranslationActivity['visibility'] = 'events',
    private clock = Date.now,
  ) {
    const now = new Date(clock()).toISOString();
    this.value = {
      startedAt: now,
      observedAt: now,
      lastDataAt: null,
      lastResponseAt: null,
      lastRetryAt: null,
      responseEvents: 0,
      receivedBytes: 0,
      timeoutMs,
      visibility,
      scope,
    };
  }
  data(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.value.receivedBytes += bytes;
    this.value.lastDataAt = new Date(this.clock()).toISOString();
  }
  event(value: unknown) {
    if (!responseActivityEvent(value)) return false;
    this.response();
    return true;
  }
  response() {
    this.value.lastResponseAt = new Date(this.clock()).toISOString();
    this.value.responseEvents++;
  }
  diagnostic(message: string) {
    if (/reconnect|retrying|stream.*disconnect|connection.*(?:lost|reset)/i.test(message))
      this.value.lastRetryAt = new Date(this.clock()).toISOString();
  }
  snapshot(): TranslationActivity {
    return { ...this.value, observedAt: new Date(this.clock()).toISOString() };
  }
}

export function activityDuration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function translationActivityView(activity: TranslationActivity, now = Date.now()) {
  const elapsed = Math.max(0, now - Date.parse(activity.startedAt));
  const quiet = Math.max(0, now - Date.parse(activity.lastResponseAt ?? activity.startedAt));
  const responseRecent = activity.lastResponseAt !== null && quiet < RECENT_MS;
  const dataRecent =
    activity.lastDataAt !== null && now - Date.parse(activity.lastDataAt) < RECENT_MS;
  const retrying =
    activity.lastRetryAt !== null &&
    Date.parse(activity.lastRetryAt) > Date.parse(activity.lastResponseAt ?? activity.startedAt);
  const stale = now - Date.parse(activity.observedAt) > 45000;
  const state = stale
    ? 'unavailable'
    : quiet >= TRANSLATION_QUIET_MS
      ? 'possibly-stalled'
      : responseRecent
        ? 'responding'
        : retrying
          ? 'reconnecting'
          : 'waiting';
  const label = {
    unavailable: 'Status update overdue',
    'possibly-stalled': 'Possibly stalled',
    responding: 'Receiving response',
    reconnecting: 'Reconnecting',
    waiting: 'Waiting for response',
  }[state];
  const progress = activity.lastResponseAt
    ? `last response activity ${activityDuration(quiet)} ago`
    : `no response progress yet (${activityDuration(elapsed)})`;
  const detail = `${activity.scope} · ${label} · ${progress} · request elapsed ${activityDuration(elapsed)}`;
  const note = stale
    ? 'The status feed is not updating; current request activity is unknown.'
    : retrying && !responseRecent
      ? 'Connection retries detected; no new response progress confirmed.'
      : dataRecent && !responseRecent
        ? 'Messages are arriving, but they do not confirm translation progress.'
        : activity.visibility === 'completion-only'
          ? 'This connection reports finished replies only; silence does not prove a stall.'
          : state === 'possibly-stalled'
            ? 'No response progress for 5 minutes. The request may still be processing; it has not been retried.'
            : 'Response activity is separate from completed, validated subtitle sections.';
  return { state, label, detail, note, elapsed, quiet };
}

// Old in-flight jobs cannot acquire new telemetry without interrupting their request.
export function legacyTranslationActivity(detail = '', updatedAt?: string, now = Date.now()) {
  const match = /Translation is running (on .+?) · (\d+)s elapsed/.exec(detail);
  if (!match) return null;
  const elapsed =
    Number(match[2]) * 1000 +
    Math.max(0, now - Date.parse(updatedAt ?? new Date(now).toISOString()));
  return {
    state: elapsed >= TRANSLATION_QUIET_MS ? 'possibly-stalled' : 'waiting',
    label: elapsed >= TRANSLATION_QUIET_MS ? 'Possibly stalled' : 'Waiting for response',
    detail: `${match[1]} · No completed reply after ${activityDuration(elapsed)}`,
    note: 'Response activity was not recorded for this existing request; the timer alone does not prove progress.',
  };
}
