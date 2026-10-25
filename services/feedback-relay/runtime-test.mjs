// Runs the deployed module in workerd with SQLite Durable Objects. All outbound
// requests are intercepted locally; no Cloudflare account or live GitHub token.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

let posts = 0;
const id = 'fb-runtime-123456789';
const mf = new Miniflare(convertV4MiniflareOptions({
  workers: [{ name: 'feedback-relay',
  modules: true, scriptPath: fileURLToPath(new URL('./src/worker.mjs', import.meta.url)),
  compatibilityDate: '2026-10-25',
  durableObjects: { REPORTS: { className: 'FeedbackLedger', useSQLite: true } },
  bindings: { ENABLED: 'true', APP_ORIGIN: 'https://ww634.github.io', TURNSTILE_HOSTNAME: 'ww634.github.io', GITHUB_REPO: 'ww634/reader-feedback', GITHUB_TOKEN: 'local-fake-only', TURNSTILE_SECRET: 'local-fake-only' },
  outboundService: async request => {
    const url = new URL(request.url);
    if (url.hostname === 'challenges.cloudflare.com') return Response.json({ success: true, hostname: 'ww634.github.io', action: 'feedback', cdata: id });
    assert.equal(url.href, 'https://api.github.com/repos/ww634/reader-feedback/issues');
    assert.equal(request.method, 'POST'); posts++;
    return Response.json({ number: 314 }, { status: 201 });
  },
  }],
}));
try {
  const payload = {
    report: { id, kind: 'translation', message: 'Runtime test.', createdAt: new Date().toISOString(), appVersion: 55, selection: { language: 'fr', bookId: 'fixture', chapterId: 'ch-1', shown: 'fourchette', pairs: [{ index: 0, target: 'fourchette', english: 'fork' }] } },
    receiptKey: 'a'.repeat(43), deviceId: 'device-runtime-123456789', turnstileToken: 'local-fake-only',
  };
  const send = () => mf.dispatchFetch('https://relay.invalid/reports', {
    method: 'POST', headers: { Origin: 'https://ww634.github.io', 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const results = await Promise.all([send(), send()]);
  for (const result of results) assert.ok([200, 202].includes(result.status), await result.text());
  assert.equal(posts, 1);
  const receipt = await mf.dispatchFetch(`https://relay.invalid/reports/${id}`, { headers: { Origin: 'https://ww634.github.io', Authorization: `Bearer ${payload.receiptKey}` } });
  assert.deepEqual(await receipt.json(), { status: 'sent', issueNumber: 314 });
  assert.deepEqual(await (await send()).json(), { status: 'sent', issueNumber: 314 });
  assert.equal(posts, 1);
  console.log('PASS: workerd + SQLite receipt, concurrent deduplication and repeat submission; all upstreams mocked.');
} finally { await mf.dispose(); }
