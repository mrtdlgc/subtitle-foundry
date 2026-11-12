import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { fetchLimited } from '../lib/http.js';

async function fixture(handler: (response: ServerResponse) => void) {
  const server = createServer((_request, response) => handler(response));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}

test('long requests use their own deadline instead of the default parser timeout', async () => {
  const original = getGlobalDispatcher();
  const shortDefault = new Agent({ headersTimeout: 50, bodyTimeout: 50 });
  const server = await fixture((response) => {
    const timer = setTimeout(() => response.end('{"ok":true}'), 1600);
    response.on('close', () => clearTimeout(timer));
  });
  setGlobalDispatcher(shortDefault);
  try {
    await assert.rejects(
      fetch(server.url),
      (error: Error & { cause?: { code?: string } }) =>
        error.cause?.code === 'UND_ERR_HEADERS_TIMEOUT',
    );
    const response = await fetchLimited(server.url, { timeout: 5000 });
    assert.deepEqual(response.json(), { ok: true });
  } finally {
    setGlobalDispatcher(original);
    await shortDefault.destroy();
    await server.close();
  }
});

test('the deadline still aborts a response whose body stalls', async () => {
  const server = await fixture((response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{');
  });
  try {
    await assert.rejects(fetchLimited(server.url, { timeout: 100 }), { name: 'TimeoutError' });
  } finally {
    await server.close();
  }
});

test('transport errors retain their code for saved request receipts', async () => {
  const server = await fixture((response) => response.destroy());
  try {
    await assert.rejects(fetchLimited(server.url, { timeout: 2000 }), /UND_ERR_SOCKET/);
  } finally {
    await server.close();
  }
});

test('response limits and provider credential redaction remain enforced', async () => {
  const server = await fixture((response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end('{"message":"bad test-secret-key"}');
  });
  const large = await fixture((response) => response.end('x'.repeat(100)));
  try {
    await assert.rejects(
      fetchLimited(server.url, { headers: { 'xi-api-key': 'test-secret-key' } }),
      (error: Error & { status?: number }) =>
        error.status === 401 &&
        error.message.includes('[redacted]') &&
        !error.message.includes('test-secret-key'),
    );
    await assert.rejects(fetchLimited(large.url, { maxBytes: 10 }), /exceeded size limit/);
  } finally {
    await server.close();
    await large.close();
  }
});

test('nested provider rejection details survive in receipts with credentials redacted', async () => {
  const server = await fixture((response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        detail: { status: 'quota_exceeded', message: 'No credits for test-secret-key' },
      }),
    );
  });
  try {
    await assert.rejects(
      fetchLimited(server.url, { headers: { 'xi-api-key': 'test-secret-key' } }),
      (error: Error & { status?: number }) =>
        error.status === 401 &&
        error.message.endsWith('quota_exceeded: No credits for [redacted]') &&
        !error.message.includes('test-secret-key'),
    );
  } finally {
    await server.close();
  }
});
