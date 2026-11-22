import { setTimeout as delay } from 'node:timers/promises';
import { checkAbort } from './process.js';
import type { TranslationRetryState } from '../../public/translation-activity.js';

export type TranslationFailureKind =
  'timeout' | 'connection' | 'response' | 'validation' | 'quota' | 'auth' | 'other';

export class TranslationFailure extends Error {
  constructor(
    message: string,
    public kind: TranslationFailureKind,
  ) {
    super(message);
    this.name = 'TranslationFailure';
  }
  get retryable() {
    return ['timeout', 'connection', 'response', 'validation'].includes(this.kind);
  }
}

// Classify before replacing provider diagnostics with a safe public message.
export function translationFailureKind(detail: string): TranslationFailureKind {
  if (
    /usage.limit|quota|insufficient.credit|billing.limit|allowance.*(?:exceed|exhaust)|(?:exceed|exhaust).*allowance|out of credit/i.test(
      detail,
    )
  )
    return 'quota';
  if (
    /401|403|unauthorized|forbidden|refresh.token|sign.in|authentication|expired|missing.*(?:key|token)/i.test(
      detail,
    )
  )
    return 'auth';
  if (/deadline|timed?\s*out|timeout|HTTP 408/i.test(detail)) return 'timeout';
  if (
    /rate.limit|HTTP (?:429|5\d\d)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket|connection.*(?:lost|reset|closed)|stream.*(?:disconnect|ended)|temporarily unavailable|server.error/i.test(
      detail,
    )
  )
    return 'connection';
  if (
    /did not complete|incomplete.*response|response.*empty|output.*empty|truncated/i.test(detail) &&
    !/refused|refusal/i.test(detail)
  )
    return 'response';
  return 'other';
}

export async function withTranslationRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    enabled: boolean;
    maximum: number;
    delayMs: number;
    signal?: AbortSignal;
    initial?: TranslationRetryState;
    onState: (state: TranslationRetryState) => Promise<void>;
  },
): Promise<T> {
  const maximum =
    Number.isInteger(options.maximum) && options.maximum >= 0 && options.maximum <= 10
      ? options.maximum
      : 3;
  const baseDelay =
    Number.isFinite(options.delayMs) && options.delayMs >= 0
      ? Math.min(options.delayMs, 300000)
      : 30000;
  let state = options.initial;
  for (;;) {
    checkAbort(options.signal);
    if (state?.nextAt) {
      if (!options.enabled || state.attempt > maximum)
        throw new Error(
          'The pending automatic translation retry is disabled by the current retry limit.',
        );
      const remaining = Math.max(0, Date.parse(state.nextAt) - Date.now());
      if (remaining) await delay(remaining, undefined, { signal: options.signal });
      checkAbort(options.signal);
      state = { ...state, nextAt: null };
      await options.onState(state);
    }
    try {
      return await operation(state?.attempt ?? 0);
    } catch (error) {
      checkAbort(options.signal);
      if (!options.enabled || !(error instanceof TranslationFailure) || !error.retryable)
        throw error;
      const attempt = (state?.attempt ?? 0) + 1;
      if (attempt > maximum) {
        if (!maximum) throw error;
        throw new TranslationFailure(
          `${error.message} Automatic retries exhausted (${maximum}/${maximum}); completed sections remain saved.`,
          error.kind,
        );
      }
      const reasons = {
        timeout: 'the request timed out',
        connection: 'a temporary connection or provider error',
        response: 'the response did not finish',
        validation: 'the model returned invalid subtitles',
      };
      state = {
        attempt,
        maximum,
        nextAt: new Date(
          Date.now() + Math.min(baseDelay * 2 ** (attempt - 1), 300000),
        ).toISOString(),
        reason: reasons[error.kind as keyof typeof reasons],
      };
      // Persist the reserved attempt before waiting or making another request.
      await options.onState(state);
    }
  }
}
