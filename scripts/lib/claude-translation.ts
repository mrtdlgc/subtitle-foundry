import fs from 'node:fs/promises';
import { at } from './files.js';
import { checkAbort, run } from './process.js';
import { hosted } from './identity.js';
import type { PipelineOptions, Settings } from '../../types/pipeline.js';

export const claudeSettingsArgs = () => [
  '--setting-sources',
  '',
  '--settings',
  JSON.stringify({
    forceLoginMethod: 'claudeai',
    disableAllHooks: true,
    autoMemoryEnabled: false,
    enabledPlugins: {},
  }),
];
export function claudeEnvironment() {
  // run() strips API keys and tokens too. Do not let cloud routing override the saved login.
  return Object.fromEntries(
    Object.keys(process.env)
      .filter((name) =>
        /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_CUSTOM|CLAUDE_CODE_API_KEY_HELPER)/.test(name),
      )
      .map((name) => [name, undefined]),
  );
}
export function claudeArgs(model: string) {
  return [
    ...claudeSettingsArgs(),
    '--print',
    '--output-format',
    'json',
    '--tools',
    '',
    '--disallowedTools',
    'mcp__*',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--system-prompt',
    'Translate the supplied subtitles. Return only the requested subtitle or JSON document. Do not use tools.',
    ...(model ? ['--model', model] : []),
  ];
}
export async function claudeStatus(settings: Settings, options: PipelineOptions = {}) {
  const unavailable = (message: string) => ({
    available: false,
    version: null,
    model: settings.CODEX_MODEL,
    message,
  });
  if (hosted)
    return unavailable(
      'Claude subscription translation is available only in personal installations.',
    );
  try {
    const cwd = at('data', 'claude-runtime');
    await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
    const result = await run(settings.CLAUDE_BIN, [...claudeSettingsArgs(), 'auth', 'status'], {
      cwd,
      env: claudeEnvironment(),
      timeout: 10000,
      maxOutput: 65536,
      signal: options.signal,
    });
    const auth = JSON.parse(result.stdout);
    if (auth.loggedIn !== true || auth.authMethod !== 'claude.ai')
      return unavailable(
        'Sign in to Claude Code with your Claude subscription using claude auth login. API-key logins are not used by this connection.',
      );
    return {
      available: true,
      version: null,
      model: settings.CODEX_MODEL,
      message: 'Translation uses your Claude Code subscription login. No API-key fallback.',
    };
  } catch {
    checkAbort(options.signal);
    return unavailable(
      'Claude Code is unavailable or signed out. Install it and run claude auth login as the user running this app.',
    );
  }
}
export async function claudeTranslation(
  prompt: string,
  settings: Settings,
  options: PipelineOptions,
) {
  const status = await claudeStatus(settings, options);
  if (!status.available) throw new Error(status.message);
  const result = await run(settings.CLAUDE_BIN, claudeArgs(settings.CODEX_MODEL), {
    cwd: options.workDir,
    input: prompt,
    env: claudeEnvironment(),
    signal: options.signal,
    timeout: settings.CODEX_TRANSLATION_TIMEOUT_MS,
    maxOutput: 8 * 1024 * 1024,
  });
  const value = JSON.parse(result.stdout);
  if (
    value.type !== 'result' ||
    value.subtype !== 'success' ||
    value.is_error !== false ||
    (value.stop_reason != null && value.stop_reason !== 'end_turn') ||
    typeof value.result !== 'string' ||
    !value.result.trim() ||
    Buffer.byteLength(value.result) > 4 * 1024 * 1024
  )
    throw new Error(
      'Claude did not complete the translation; check your subscription allowance and retry manually.',
    );
  return { text: value.result, usage: value.usage ?? null };
}
