import { at } from './files.js';
import { run } from './process.js';
import type { RunOptions } from './process.js';
import { credential, validateYouTubeBrowser, withYouTubeCookies } from './credentials.js';
import { hosted } from './identity.js';

export async function youtube(args: string[], options: RunOptions = {}) {
  const browser = hosted ? undefined : await credential('YOUTUBE_BROWSER');
  if (browser) validateYouTubeBrowser(browser);
  const invoke = async (cookies?: string) => {
    try {
      return await run(
        process.env.YTDLP_BIN || 'yt-dlp',
        [
          '--ignore-config',
          '--no-plugin-dirs',
          '--no-remote-components',
          '--no-js-runtimes',
          '--js-runtimes',
          `node:${process.execPath}`,
          '--no-playlist',
          '--socket-timeout',
          '20',
          '--retries',
          '3',
          '--fragment-retries',
          '3',
          '--extractor-retries',
          '2',
          '--cache-dir',
          at('data', 'yt-dlp-cache'),
          ...(browser ? ['--cookies-from-browser', browser] : []),
          ...(cookies ? ['--cookies', cookies] : []),
          ...args,
        ],
        options,
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const detail = String(error.message);
      if (/ENOENT/.test(detail))
        throw new Error(
          'yt-dlp is missing. Install requirements-download.txt; the Docker image includes it.',
        );
      if (
        browser &&
        /cookie.*database|database.*locked|could not copy|could not find.*cookies|failed to (?:load|decrypt)|keyring|secretstorage|secret service|\bDPAPI\b|\bD-Bus\b/i.test(
          detail,
        )
      )
        throw new Error(
          'Could not read the selected browser session. Sign in to YouTube in that browser, check the profile in Connections, and run the app as the same desktop user with an unlocked keyring. Linux Chromium browsers also need SecretStorage from requirements-download.txt. A container cannot access your desktop browser automatically; use a cookies export there.',
        );
      if (
        /sign in|confirm you.re not a bot|cookies|HTTP Error 403|HTTP Error 429|PO Token/i.test(
          detail,
        )
      ) {
        throw new Error(
          browser
            ? 'YouTube rejected the selected browser session. Open YouTube in that browser/profile, sign in and complete any verification, then retry. You can also upload local audio; cookies do not guarantee access.'
            : 'YouTube rejected access from this server. In a local installation, select your browser in Connections → YouTube browser session, or save a fresh cookies.txt export and retry. You can also upload audio. Some hosting IPs remain blocked even with cookies.',
        );
      }
      if (/challenge|javascript|js runtime|signature|nsig/i.test(detail)) {
        throw new Error(
          'YouTube challenge solving failed. Update yt-dlp and its matching yt-dlp-ejs package using requirements-download.txt, then rebuild the image. Node is enabled automatically.',
        );
      }
      if (/private video|video unavailable|not available|members.only/i.test(detail))
        throw new Error(
          'This YouTube video is unavailable to the server/account. Check the link or upload a local audio file.',
        );
      throw error;
    }
  };
  // Read fresh browser cookies for every invocation without exporting the browser's cookie jar.
  // A selected browser takes precedence over any older saved export.
  return browser ? invoke() : withYouTubeCookies(invoke);
}
