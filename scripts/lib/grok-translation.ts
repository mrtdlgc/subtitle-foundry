import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkAbort, run } from './process.js';
import { hosted } from './identity.js';
import type { PipelineOptions, Settings } from '../../types/pipeline.js';

const loginMessage =
  'Install Grok Build and run grok login --oauth as the user running this app. This connection requires a browser login with Grok Build access; API-key authentication is disabled.';
class GrokConfigurationError extends Error {}

// Use the CLI's saved login in place. Never read or copy its token into the application.
function authPath() {
  return path.resolve(
    process.env.GROK_AUTH_PATH ||
      path.join(process.env.GROK_HOME || path.join(os.homedir(), '.grok'), 'auth.json'),
  );
}
export function grokEnvironment(runtime: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.keys(process.env)
      .filter((name) => /^(GROK_|XAI_|OTEL_)/.test(name))
      .map((name) => [name, undefined]),
  );
  Object.assign(env, {
    GROK_HOME: runtime,
    GROK_AUTH_PATH: authPath(),
    GROK_DISABLE_API_KEY_AUTH: '1',
    GROK_DISABLE_AUTOUPDATER: '1',
    GROK_MANAGED_MCP_GATEWAY_TOOLS_ENABLED: '0',
    GROK_MEMORY: '0',
    GROK_EXTERNAL_OTEL: '0',
  });
  for (const vendor of ['CLAUDE', 'CURSOR'])
    for (const surface of ['AGENTS', 'HOOKS', 'MCPS', 'RULES', 'SKILLS'])
      env[`GROK_${vendor}_${surface}_ENABLED`] = '0';
  return env;
}

export function grokArgs(model: string, promptFile: string) {
  return [
    '--prompt-file',
    promptFile,
    '--output-format',
    'json',
    '--tools',
    '',
    '--deny',
    '*',
    '--permission-mode',
    'dontAsk',
    '--disable-web-search',
    '--no-subagents',
    '--max-turns',
    '1',
    '--verbatim',
    '--system-prompt-override',
    'Translate the supplied subtitles. Return only the requested subtitle or JSON document. Do not use tools.',
    ...(model ? ['--model', model] : []),
  ];
}

async function withRuntime<T>(
  settings: Settings,
  options: PipelineOptions,
  fn: (runtime: string, env: NodeJS.ProcessEnv, version: string) => Promise<T>,
) {
  if (hosted)
    throw new Error('Grok subscription translation is available only in personal installations.');
  checkAbort(options.signal);
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'subtitle-foundry-grok-'));
  try {
    // An isolated home/cwd prevents coding-project instructions, plugins and tool servers
    // from being loaded. The authentication path alone points at the user's existing login.
    await fs.writeFile(
      path.join(runtime, 'config.toml'),
      `[auth]
preferred_method = "oidc"
disable_api_key_auth = true
[cli]
use_leader = false
auto_update = false
[models]
max_retries = 0
rate_limit_retry_threshold = 1
[memory]
enabled = false
[memory_v2]
enabled = false
capture_enabled = false
automatic_dream_enabled = false
[compat.codex]
hooks = false
skills = false
[toolset.bash]
login_shell_capture = false
`,
      { mode: 0o600 },
    );
    const env = grokEnvironment(runtime);
    const inspect = async () => {
      const result = await run(settings.GROK_BIN, ['inspect', '--json'], {
        cwd: runtime,
        env,
        timeout: 10000,
        maxOutput: 1024 * 1024,
        signal: options.signal,
      });
      return JSON.parse(result.stdout);
    };
    let report = await inspect();
    // Grok discovers some third-party plugins outside GROK_HOME. Disable the discovered
    // names in our private config, then verify the effective configuration again.
    const disabledPlugins: string[] = [];
    if (Array.isArray(report.plugins) && report.plugins.length) {
      const names = report.plugins.map((p: any) => p.name);
      if (!names.every((name: unknown) => typeof name === 'string'))
        throw new GrokConfigurationError('Update Grok Build: unrecognized plugin configuration.');
      await fs.appendFile(
        path.join(runtime, 'config.toml'),
        `\n[plugins]\ndisabled = ${JSON.stringify(names)}\n`,
      );
      disabledPlugins.push(...names);
      report = await inspect();
    }
    if (report.loginPolicy?.apiKeyAuthDisabled !== true)
      throw new GrokConfigurationError(
        'Update Grok Build: its CLI must support blocking API-key authentication.',
      );
    // Enterprise policy may add executable extensions even to an isolated home. Refuse
    // these instead of running them while processing untrusted subtitle text.
    if (
      ['hooks', 'mcpServers', 'lspServers'].some(
        (key) =>
          !Array.isArray(report[key]) || report[key].some((entry: any) => entry.disabled !== true),
      ) ||
      // inspect's plugin `enabled` field currently reports folder trust, not the
      // effective enabled/disabled setting. Guard names plus executable surfaces.
      !Array.isArray(report.plugins) ||
      report.plugins.some((p: any) => !disabledPlugins.includes(p.name))
    )
      throw new GrokConfigurationError(
        'Grok translation requires a CLI environment without hooks, plugins or tool servers.',
      );
    if (!(await fs.stat(env.GROK_AUTH_PATH!)).isFile()) throw new Error(loginMessage);
    return await fn(runtime, env, String(report.grokVersion || 'Grok Build'));
  } finally {
    await fs.rm(runtime, { recursive: true, force: true });
  }
}

export async function grokStatus(settings: Settings, options: PipelineOptions = {}) {
  try {
    return await withRuntime(settings, options, async (_runtime, _env, version) => ({
      available: true,
      version,
      model: settings.CODEX_MODEL,
      message:
        'Grok Build is ready. The CLI checks your saved browser login and allowance when translation starts. API-key fallback is disabled.',
    }));
  } catch (error) {
    checkAbort(options.signal);
    return {
      available: false,
      version: null,
      model: settings.CODEX_MODEL,
      message: error instanceof GrokConfigurationError ? error.message : loginMessage,
    };
  }
}

export async function grokTranslation(
  prompt: string,
  settings: Settings,
  options: PipelineOptions,
) {
  return withRuntime(settings, options, async (runtime, env) => {
    const promptFile = path.join(runtime, 'prompt.txt');
    await fs.writeFile(promptFile, prompt, { mode: 0o600 });
    let stdout: string;
    try {
      ({ stdout } = await run(settings.GROK_BIN, grokArgs(settings.CODEX_MODEL, promptFile), {
        cwd: runtime,
        env,
        signal: options.signal,
        timeout: settings.CODEX_TRANSLATION_TIMEOUT_MS,
        maxOutput: 8 * 1024 * 1024,
      }));
    } catch {
      checkAbort(options.signal);
      throw new Error(
        'Grok did not complete the translation. Check your browser login, model and allowance, then retry manually. No API-key fallback was used.',
      );
    }
    const value = JSON.parse(stdout);
    if (
      value.stopReason !== 'end_turn' ||
      typeof value.text !== 'string' ||
      !value.text.trim() ||
      Buffer.byteLength(value.text) > 4 * 1024 * 1024
    )
      throw new Error('Grok returned an incomplete translation; retry manually.');
    return { text: value.text, usage: value.usage ?? null };
  });
}
