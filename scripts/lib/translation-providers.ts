import type { Settings } from '../../types/pipeline.js';
import type { CredentialName } from './credentials.js';

export interface TranslationProvider {
  id: string;
  name: string;
  kind: 'subscription' | 'api';
  local: boolean;
  key?: CredentialName;
  defaultModel: string;
  billing: string;
}

// Subscription connections come first. Changing billing always requires an explicit selection.
export const translationProviders: TranslationProvider[] = [
  {
    id: 'codex-local',
    name: 'Codex · ChatGPT subscription',
    kind: 'subscription',
    local: true,
    defaultModel: '',
    billing: 'Uses your existing Codex login and ChatGPT allowance.',
  },
  {
    id: 'claude-local',
    name: 'Claude Code · Claude subscription',
    kind: 'subscription',
    local: true,
    defaultModel: '',
    billing: 'Uses your existing Claude Code login and Claude allowance.',
  },
  {
    id: 'grok-local',
    name: 'Grok Build · Grok subscription',
    kind: 'subscription',
    local: true,
    defaultModel: '',
    billing:
      'Uses your Grok Build browser login and account allowance. Account extra usage settings apply.',
  },
  {
    id: 'chatgpt-oauth',
    name: 'ChatGPT subscription',
    kind: 'subscription',
    local: false,
    defaultModel: 'gpt-5.4',
    billing: 'Uses your connected ChatGPT plan when hosted access is enabled.',
  },
  {
    id: 'openai-api',
    name: 'OpenAI · API key',
    kind: 'api',
    local: false,
    key: 'OPENAI_API_KEY',
    defaultModel: 'gpt-5.4',
    billing: 'Billed to your OpenAI API account, separately from subscriptions.',
  },
  {
    id: 'anthropic-api',
    name: 'Anthropic · API key',
    kind: 'api',
    local: false,
    key: 'ANTHROPIC_API_KEY',
    defaultModel: '',
    billing: 'Billed to your Anthropic API account, separately from Claude subscriptions.',
  },
  {
    id: 'gemini-api',
    name: 'Google Gemini · API key',
    kind: 'api',
    local: false,
    key: 'GEMINI_API_KEY',
    defaultModel: '',
    billing: 'Uses your Gemini API account quota and billing.',
  },
  {
    id: 'xai-api',
    name: 'Grok (xAI) · API key',
    kind: 'api',
    local: false,
    key: 'XAI_API_KEY',
    defaultModel: '',
    billing: 'Uses your xAI API account quota and billing; select this connection explicitly.',
  },
  {
    id: 'openrouter-api',
    name: 'OpenRouter · API key',
    kind: 'api',
    local: false,
    key: 'OPENROUTER_API_KEY',
    defaultModel: '',
    billing: 'Uses OpenRouter credits; upstream subscriptions do not transfer.',
  },
];

export function translationProvider(id: string) {
  const provider = translationProviders.find((item) => item.id === id);
  if (!provider) throw new Error('Choose a supported translation provider');
  return provider;
}
export function translationModel(settings: Settings) {
  return settings.CODEX_MODEL || translationProvider(settings.TRANSLATION_PROVIDER).defaultModel;
}
export function validateTranslationSettings(settings: Settings) {
  translationProvider(settings.TRANSLATION_PROVIDER);
  if (
    typeof settings.CODEX_MODEL !== 'string' ||
    (settings.CODEX_MODEL && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(settings.CODEX_MODEL))
  )
    throw new Error('Invalid translation model');
  if (
    !Number.isSafeInteger(settings.TRANSLATION_MAX_OUTPUT_TOKENS) ||
    settings.TRANSLATION_MAX_OUTPUT_TOKENS < 1024 ||
    settings.TRANSLATION_MAX_OUTPUT_TOKENS > 131072
  )
    throw new Error('Translation output limit must be between 1024 and 131072 tokens');
}
