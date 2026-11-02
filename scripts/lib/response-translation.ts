import { credential } from './credentials.js';
import { chatGPTStatus, chatGPTToken } from './chatgpt-oauth.js';
import { assertPaidSubmissionAllowed, trackPaidWork } from './paid-work.js';
import { translationProvider, translationModel } from './translation-providers.js';
import type { Settings } from '../../types/pipeline.js';

export async function responseStatus(settings: Settings) {
  const provider = translationProvider(settings.TRANSLATION_PROVIDER);
  const plan = provider.id === 'chatgpt-oauth';
  const model = translationModel(settings);
  const connected = plan
    ? chatGPTStatus().connected
    : Boolean(await credential(provider.key ?? null));
  return {
    available: connected && Boolean(model),
    version: null,
    model,
    message: !connected
      ? plan
        ? chatGPTStatus().message
        : `Add your ${provider.name.split(' · ')[0]} API key in Connections to translate subtitles.`
      : !model
        ? 'Enter a translation model ID available to your provider account.'
        : `Ready to translate with ${provider.name.split(' · ')[0]}.`,
  };
}

function translationRequest(prompt: string, settings: Settings, token: string) {
  const model = translationModel(settings);
  if (!model) throw new Error('Choose a translation model before submitting');
  const max = settings.TRANSLATION_MAX_OUTPUT_TOKENS;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  switch (settings.TRANSLATION_PROVIDER) {
    case 'openai-api':
    case 'chatgpt-oauth':
    case 'xai-api':
      return {
        url:
          settings.TRANSLATION_PROVIDER === 'xai-api'
            ? 'https://api.x.ai/v1/responses'
            : 'https://api.openai.com/v1/responses',
        headers: { ...headers, Authorization: `Bearer ${token}` },
        body: {
          model,
          store: false,
          stream: true,
          input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
        },
      };
    case 'openrouter-api':
      return {
        url: 'https://openrouter.ai/api/v1/chat/completions',
        headers: { ...headers, Authorization: `Bearer ${token}` },
        body: {
          model,
          stream: true,
          max_tokens: max,
          messages: [{ role: 'user', content: prompt }],
        },
      };
    case 'anthropic-api':
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: { ...headers, 'x-api-key': token, 'anthropic-version': '2023-06-01' },
        body: {
          model,
          stream: true,
          max_tokens: max,
          messages: [{ role: 'user', content: prompt }],
        },
      };
    case 'gemini-api':
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model.replace(/^models\//, ''))}:streamGenerateContent?alt=sse`,
        headers: { ...headers, 'x-goog-api-key': token },
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: max, candidateCount: 1 },
        },
      };
    default:
      throw new Error('Choose an API translation provider');
  }
}
export async function responseTranslation(
  prompt: string,
  settings: Settings,
  signal?: AbortSignal,
) {
  const provider = translationProvider(settings.TRANSLATION_PROVIDER);
  const token =
    provider.id === 'chatgpt-oauth' ? await chatGPTToken() : await credential(provider.key ?? null);
  if (!token) throw new Error('Your translation connection expired or is missing');
  const request = translationRequest(prompt, settings, token);
  assertPaidSubmissionAllowed();
  return trackPaidWork(async () => {
    const deadline = AbortSignal.timeout(settings.CODEX_TRANSLATION_TIMEOUT_MS);
    const response = await fetch(request.url, {
      method: 'POST',
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: request.headers,
      body: JSON.stringify(request.body),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Translation provider returned HTTP ${response.status}. Check your connection and allowance; retry manually.`,
      );
    }
    if (!response.body) throw new Error('Translation response was empty');
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let pending = '',
      size = 0;
    let completed: { text: string; usage: unknown } | undefined;
    let text = '',
      usage: any = null,
      finished = false,
      stop = '',
      sawStart = false;
    const append = (value: unknown) => {
      if (typeof value !== 'string') throw new Error('Invalid translation text');
      text += value;
      if (Buffer.byteLength(text) > 4 * 1024 * 1024)
        throw new Error('Translation output exceeded its size limit');
    };
    const finish = () => {
      if (!text.trim()) throw new Error('Translation output was empty');
      completed = { text, usage };
    };
    const event = (block: string) => {
      const payload = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!payload) return;
      if (payload === '[DONE]') {
        if (provider.id === 'openrouter-api' && finished) finish();
        return;
      }
      const value = JSON.parse(payload);
      if (value.error || value.type === 'error')
        throw new Error('Translation provider rejected the request');
      if (provider.id === 'openrouter-api') {
        if (value.usage) usage = value.usage;
        for (const choice of value.choices ?? []) {
          if (choice.index !== 0 || choice.delta?.tool_calls || choice.delta?.refusal)
            throw new Error('Unexpected translation response');
          if (choice.delta?.content) append(choice.delta.content);
          if (choice.finish_reason) {
            if (choice.finish_reason !== 'stop')
              throw new Error('Translation was truncated or refused');
            finished = true;
          }
        }
        return;
      }
      if (provider.id === 'anthropic-api') {
        if (value.type === 'message_start') {
          sawStart = true;
          usage = value.message?.usage ?? null;
        }
        if (value.type === 'content_block_start' && value.content_block?.type === 'text')
          append(value.content_block.text ?? '');
        if (value.type === 'content_block_delta' && value.delta?.type === 'text_delta')
          append(value.delta.text);
        if (value.type === 'message_delta') {
          stop = value.delta?.stop_reason ?? stop;
          usage = { ...usage, ...value.usage };
        }
        if (value.type === 'message_stop') {
          if (!sawStart || stop !== 'end_turn')
            throw new Error('Translation was truncated or refused');
          finish();
        }
        return;
      }
      if (provider.id === 'gemini-api') {
        if (value.promptFeedback?.blockReason) throw new Error('Translation was refused');
        if (value.usageMetadata) usage = value.usageMetadata;
        for (const candidate of value.candidates ?? []) {
          if (candidate.index && candidate.index !== 0)
            throw new Error('Unexpected translation candidate');
          for (const part of candidate.content?.parts ?? [])
            if (part.text !== undefined && !part.thought) append(part.text);
          if (candidate.finishReason) {
            if (candidate.finishReason !== 'STOP')
              throw new Error('Translation was truncated or refused');
            finish();
          }
        }
        return;
      }
      if (['response.failed', 'response.incomplete', 'error'].includes(value.type))
        throw new Error(
          'The translation did not complete. Retry manually; no billing fallback was used.',
        );
      if (value.type === 'response.completed') {
        if (value.response?.status !== 'completed')
          throw new Error('Incomplete translation response');
        const output = value.response.output;
        if (!Array.isArray(output)) throw new Error('Invalid translation response');
        const text = output
          .filter((item) => item.type === 'message' && item.role === 'assistant')
          .flatMap((item) => item.content ?? [])
          .filter((item) => item.type === 'output_text')
          .map((item) => item.text)
          .join('');
        if (!text || Buffer.byteLength(text) > 4 * 1024 * 1024)
          throw new Error('Translation output was empty or too large');
        completed = { text, usage: value.response.usage ?? null };
      }
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 16 * 1024 * 1024) throw new Error('Translation stream exceeded its size limit');
        pending += decoder.decode(value, { stream: true });
        pending = pending.replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          event(pending.slice(0, boundary));
          pending = pending.slice(boundary + 2);
        }
      }
      event(pending + decoder.decode());
    } finally {
      await reader.cancel().catch(() => {});
    }
    if (!completed) throw new Error('Translation stream ended before completion. Retry manually.');
    return {
      ...completed,
      usage: ['openai-api', 'chatgpt-oauth', 'xai-api'].includes(provider.id)
        ? completed.usage
        : usage,
    };
  });
}
