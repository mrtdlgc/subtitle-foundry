import type { Settings } from '../../types/pipeline.js';

export function isDirectScribe(model: string): boolean {
  return ['scribe_v3', 'scribe_v2'].includes(model);
}

export function fullMovie(settings: Partial<Settings>): boolean {
  return (
    settings.TRANSCRIPTION_MODE === 'movie' ||
    (settings.TRANSCRIPTION_MODE === 'auto' && settings.TRANSCRIBE_BACKEND === 'elevenlabs')
  );
}

export function scribeDiarization(settings: Partial<Settings>): boolean {
  return Boolean(
    settings.TRANSCRIPTION_DIARIZATION &&
    ((settings.TRANSCRIBE_BACKEND === 'elevenlabs' &&
      (!settings.TRANSCRIPTION_MODEL || isDirectScribe(settings.TRANSCRIPTION_MODEL))) ||
      (settings.TRANSCRIBE_BACKEND === 'openrouter' &&
        (!settings.TRANSCRIPTION_MODEL ||
          settings.TRANSCRIPTION_MODEL === 'elevenlabs/scribe-v2'))),
  );
}

export function scribeAudioEvents(settings: Partial<Settings>): boolean {
  return Boolean(
    settings.TRANSCRIPTION_AUDIO_EVENTS &&
    scribeDiarization({ ...settings, TRANSCRIPTION_DIARIZATION: true }),
  );
}

export function movieSettings(settings: Settings): Settings {
  return fullMovie(settings)
    ? {
        ...settings,
        // Native timestamps are retained. Local audio analysis stays in chunked mode.
        SILERO_VAD_ENABLED: false,
        ALIGN_TO_SPEECH: false,
        FILTER_HALLUCINATIONS: false,
        WHISPER_PROMPT_ENABLED: false,
      }
    : settings;
}
