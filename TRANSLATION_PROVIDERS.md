# Translation connections

Choose a **Translation connection** and model in Studio or the translation desk. The two forms share
the selection, but each queued job retains its own provider and model. Transcription and translation
can use different vendors. Every translation receives the complete subtitle context and passes the
same exact-timing or editorial source-anchor validation before publication.

Subscription connections appear first. Personal installations default to **Codex**. An unavailable
login or exhausted allowance fails the job; the app never switches to another provider or API
billing automatically. Provider-side extra usage settings and plan limits still apply.

| Connection        | Authentication                                          | Availability                                             |
| ----------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| Codex             | Existing ChatGPT login in Codex CLI                     | Personal local or self-hosted installation               |
| Claude Code       | Existing Claude subscription login in Claude Code CLI   | Personal local or self-hosted installation               |
| Grok Build        | Existing Grok Build browser login and account allowance | Personal local or self-hosted installation with Grok CLI |
| ChatGPT plan      | Approved hosted OAuth integration                       | Hosted mode, disabled until configured and connected     |
| OpenAI API        | OpenAI key in Connections                               | Personal and hosted                                      |
| Anthropic API     | Anthropic key in Connections                            | Personal and hosted                                      |
| Google Gemini API | Gemini key in Connections                               | Personal and hosted                                      |
| Grok (xAI) API    | xAI key in Connections                                  | Personal and hosted                                      |
| OpenRouter API    | OpenRouter key in Connections                           | Personal and hosted                                      |

## Use a subscription

Run the login command as the same OS user running the application:

```sh
codex login
claude auth login
grok login --oauth
```

Select **Codex · ChatGPT subscription**, **Claude Code · Claude subscription**, or **Grok Build ·
Grok subscription**. Leave the model blank to use the CLI's default, or enter a model available to
your subscription. Claude also accepts aliases such as `sonnet` and `opus`. Use Refresh after
signing in. An API-key login is not accepted as a subscription connection. The app invokes the
official CLI; it does not copy or export login tokens. API credentials are removed from the CLI
environment, and translation tools, hooks and MCP connections are disabled.

Grok Build is an optional separate install from the
[official installation guide](https://docs.x.ai/build/overview). Use a current CLI with API-key
authentication lockdown (verified with 1.0.46). Set `GROK_BIN` to its absolute executable path if
the app's PATH does not include it. Its browser login must have Grok Build access; account allowance
and extra usage settings still apply. Readiness checks verify the executable, auth policy and
presence of a saved login; the CLI verifies that login when the translation starts. An expired login
or API-only login fails without switching billing methods.

Grok runs in a temporary workspace with coding plugins disabled and uses the existing login path in
place (`GROK_AUTH_PATH`, or `GROK_HOME/auth.json`, default `~/.grok/auth.json`). The app does not
read its credentials or inherit custom model endpoints. Leave the model blank for Grok's built-in
default, or choose it explicitly; your normal Grok coding configuration is not imported. Temporary
prompt and session files are removed when the call finishes or is cancelled. A managed configuration
that adds active hooks or tool servers is rejected before translation. The standard Docker image
does not bundle Grok: install it in a custom image and persist its login directory to use this
route.

The npm dependencies include pinned Codex and Claude Code CLIs. `npm install` prepares Claude's
native executable. If dependencies were installed using `--ignore-scripts`, run:

```sh
node node_modules/@anthropic-ai/claude-code/install.cjs
```

For a native service with a restricted PATH, set `CODEX_BIN` and `CLAUDE_BIN` to the corresponding
absolute executable paths, for example `/path/to/subtitle-foundry/node_modules/.bin/claude`.

The Docker image includes both CLIs. Sign in inside a personal installation's container:

```sh
docker compose exec studio codex login --device-auth
docker compose exec studio claude auth login
```

Complete each CLI's browser login yourself. Docker retains Codex login state under
`/data/data/private/codex` and Claude state under `/data/data/private/claude`. Preserve the volume
when redeploying. A public hosted service does not share either server-owner subscription with its
users; see [hosted accounts](HOSTED.md).

## Explicit API choices

Save the selected vendor's key in **Connections**, then select its API connection. Existing OpenAI,
Gemini, xAI and OpenRouter keys can also serve translation. Anthropic has its own key field. Hosted
keys remain scoped to the signed-in user's account, with temporary session storage by default.

Enter a text-generation model ID from your provider's catalog. OpenRouter uses `vendor/model`
identifiers and provides access to additional vendors through that account. Anthropic, Gemini, xAI
and OpenRouter require an explicit model; OpenAI defaults to `gpt-5.4`. Choose a model whose context
and output limits accommodate the whole film, especially for editorial JSON output.

API translation usage is separate from transcription estimates and follows the selected API
account's quota and billing. The app retains returned token usage in the translation report.
`TRANSLATION_MAX_OUTPUT_TOKENS` (default `32768`) bounds the requested output for Anthropic, Gemini
and OpenRouter; lower it if the selected model supports a smaller limit. A truncated, refused or
interrupted response is never published as a completed subtitle. There is no automatic continuation
or replacement request.

For new jobs and folder-scanned films, `TRANSLATION_PROVIDER` and `TRANSLATION_MODEL` set server
defaults. `CODEX_MODEL` remains a compatibility fallback for the model setting.
`CODEX_TRANSLATION_TIMEOUT_MS` controls the translation deadline across all providers. Existing jobs
keep their saved selection. Start a new job when changing provider or model; completed receipts are
reused only for matching work. Manual subtitle corrections never trigger another model call.

Provider references: [Claude Code programmatic use](https://code.claude.com/docs/en/headless),
[Claude authentication](https://code.claude.com/docs/en/authentication),
[Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming),
[Gemini generation](https://ai.google.dev/api/generate-content),
[OpenRouter streaming](https://openrouter.ai/docs/api/reference/streaming),
[Grok headless mode](https://docs.x.ai/build/cli/headless-scripting), and
[xAI Responses API](https://docs.x.ai/developers/rest-api-reference/inference/responses).
