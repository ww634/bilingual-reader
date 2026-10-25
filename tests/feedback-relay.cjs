const test = require('node:test');
const assert = require('node:assert/strict');

class MemoryStorage {
  constructor() { this.rows = new Map(); this.queue = Promise.resolve(); }
  async get(key) { return structuredClone(this.rows.get(key)); }
  async put(key, value) { this.rows.set(key, structuredClone(value)); }
  async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) this.rows.delete(key); }
  async list({ prefix, startAfter = '', limit }) { return new Map([...this.rows].sort(([a], [b]) => a.localeCompare(b)).filter(([key]) => key.startsWith(prefix) && key > startAfter).slice(0, limit)); }
  async setAlarm(value) { this.alarm = value; }
  async getAlarm() { return this.alarm || null; }
  transaction(fn) {
    const result = this.queue.then(async () => {
      const backup = structuredClone(this.rows);
      try { return await fn(this); } catch (error) { this.rows = backup; throw error; }
    });
    this.queue = result.catch(() => {});
    return result;
  }
}

async function fixture(github) {
  const { FeedbackLedger, createWorker } = await import('../services/feedback-relay/src/worker.mjs');
  const storage = new MemoryStorage();
  const env = { APP_ORIGIN: 'https://ww634.github.io', TURNSTILE_HOSTNAME: 'ww634.github.io', GITHUB_REPO: 'ww634/reader-feedback', ENABLED: 'true', GITHUB_TOKEN: 'test-only-server-token', TURNSTILE_SECRET: 'test-only-challenge-secret' };
  let calls = 0, verification = {}, issuePayload;
  const ledger = new FeedbackLedger({ storage }, env, async (url, options) => {
    calls++; assert.equal(url, 'https://api.github.com/repos/ww634/reader-feedback/issues');
    assert.equal(options.headers.Authorization, 'Bearer test-only-server-token');
    issuePayload = JSON.parse(options.body);
    return github ? github(url, options) : Response.json({ number: 42 }, { status: 201 });
  });
  env.REPORTS = { idFromName: name => name, get: () => ledger };
  const worker = createWorker(async (url, options) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const input = JSON.parse(options.body); assert.equal(input.secret, env.TURNSTILE_SECRET);
    return Response.json({ success: true, hostname: env.TURNSTILE_HOSTNAME, action: 'feedback', cdata: current.report.id, ...verification });
  });
  const report = id => ({ id, kind: 'translation', message: 'This word means fork.', createdAt: '2026-10-25T12:00:00Z', appVersion: 55, selection: { language: 'fr', bookId: 'example', chapterId: 'ch-1', shown: 'fourchette', pairs: [{ index: 0, target: 'sa fourchette', english: 'his fork' }] } });
  let current;
  const payload = (id = 'fb-123456789012') => ({ report: report(id), deviceId: 'device-123456789', receiptKey: 'a'.repeat(43), turnstileToken: 'test-token' });
  const submit = async (body = payload(), headers = {}) => {
    current = body;
    return worker.fetch(new Request('https://relay.invalid/reports', { method: 'POST', headers: { Origin: env.APP_ORIGIN, 'CF-Connecting-IP': '192.0.2.1', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }), env);
  };
  return { worker, env, storage, payload, submit, get calls() { return calls; }, get issuePayload() { return issuePayload; }, setVerification: value => { verification = value; } };
}

test('feedback relay strips credentials, fixes destination and deduplicates concurrent delivery', async () => {
  const f = await fixture();
  const payload = f.payload(); payload.report.feedbackToken = 'must-not-leave'; payload.report.selection.openaiKey = 'must-not-leave';
  const results = await Promise.all([f.submit(payload), f.submit(payload)]);
  assert.ok(results.every(r => [200, 202].includes(r.status))); assert.equal(f.calls, 1);
  assert.match(f.issuePayload.body, /^<!-- reader-report:fb-123456789012 -->/);
  assert.ok(!JSON.stringify(f.issuePayload).includes('must-not-leave'));
  assert.ok(!JSON.stringify([...f.storage.rows]).includes('fork'));
  assert.ok(!JSON.stringify([...f.storage.rows]).includes('192.0.2.1'));
  const duplicate = await f.submit(payload); assert.deepEqual(await duplicate.json(), { status: 'sent', issueNumber: 42 });
  payload.report.message = 'Changed'; assert.equal((await f.submit(payload)).status, 409); assert.equal(f.calls, 1);
});

test('feedback receipt requires its secret and reveals no report context', async () => {
  const f = await fixture(); await f.submit();
  const status = key => f.worker.fetch(new Request('https://relay.invalid/reports/fb-123456789012', { headers: { Origin: f.env.APP_ORIGIN, Authorization: `Bearer ${key}` } }), f.env);
  assert.equal((await status('b'.repeat(43))).status, 404);
  assert.deepEqual(await (await status('a'.repeat(43))).json(), { status: 'sent', issueNumber: 42 });
});

test('feedback fails closed on wrong origin, disabled service and invalid challenge bindings', async () => {
  const f = await fixture();
  assert.equal((await f.submit(f.payload(), { Origin: 'https://evil.invalid' })).status, 403);
  f.env.ENABLED = 'false'; assert.equal((await f.submit()).status, 503); f.env.ENABLED = 'true';
  for (const verification of [{ success: false }, { hostname: 'evil.invalid' }, { action: 'login' }, { cdata: 'another-report' }]) {
    f.setVerification(verification); assert.equal((await f.submit()).status, 403);
  }
  assert.equal(f.calls, 0);
});

test('feedback enforces streaming byte limits and validates sentence references', async () => {
  const f = await fixture(); const body = f.payload(); body.report.message = 'x'.repeat(21000);
  assert.equal((await f.submit(body)).status, 413);
  body.report.message = 'test'; body.report.selection.pairs[0].index = -1;
  assert.equal((await f.submit(body)).status, 400); assert.equal(f.calls, 0);
});

test('feedback reserves daily quota atomically and duplicate receipts do not consume it again', async () => {
  const f = await fixture();
  for (let n = 0; n < 10; n++) assert.equal((await f.submit(f.payload(`fb-1234567890${String(n).padStart(2, '0')}`))).status, 200);
  assert.equal((await f.submit(f.payload('fb-123456789099'))).status, 429);
  assert.equal((await f.submit(f.payload('fb-123456789000'))).status, 200); assert.equal(f.calls, 10);
});

test('ambiguous GitHub result never automatically posts again, including after restart', async () => {
  for (const upstream of [async () => { throw new Error('private timeout details'); }, async () => new Response('private upstream details', { status: 500 })]) {
    const f = await fixture(upstream);
    assert.deepEqual(await (await f.submit()).json(), { status: 'needs-review' });
    assert.deepEqual(await (await f.submit()).json(), { status: 'needs-review' });
    assert.equal(f.calls, 1);
    const { FeedbackLedger } = await import('../services/feedback-relay/src/worker.mjs');
    const restarted = new FeedbackLedger({ storage: f.storage }, f.env, upstream);
    f.env.REPORTS.get = () => restarted;
    assert.deepEqual(await (await f.submit()).json(), { status: 'needs-review' });
    assert.equal(f.calls, 1);
  }
});

test('counter cleanup preserves report deduplication records', async () => {
  const f = await fixture(); await f.submit();
  await f.storage.put('quota:2000-01-01:global', 5);
  const { FeedbackLedger } = await import('../services/feedback-relay/src/worker.mjs');
  await new FeedbackLedger({ storage: f.storage }, f.env).alarm();
  assert.equal(await f.storage.get('quota:2000-01-01:global'), undefined);
  assert.ok(await f.storage.get('report:fb-123456789012'));
});

test('only an authenticated operator can reconcile an uncertain GitHub receipt, without reposting', async () => {
  const f = await fixture(async () => { throw new Error('Lost reply'); }); await f.submit();
  f.env.ADMIN_TOKEN = 'test-only-operator-secret';
  const { FeedbackLedger } = await import('../services/feedback-relay/src/worker.mjs');
  let gets = 0;
  const recovery = new FeedbackLedger({ storage: f.storage }, f.env, async (url, options) => {
    assert.equal(options.method, undefined); assert.match(url, /state=all/); gets++;
    return Response.json([{ number: 42, body: '<!-- reader-report:fb-123456789012 -->\nreport' }]);
  });
  f.env.REPORTS.get = () => recovery;
  const request = token => f.worker.fetch(new Request('https://relay.invalid/admin/reconcile', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id: 'fb-123456789012' }),
  }), f.env);
  assert.equal((await request('wrong')).status, 404); assert.equal(gets, 0);
  assert.deepEqual(await (await request(f.env.ADMIN_TOKEN)).json(), { status: 'sent', issueNumber: 42 });
  assert.equal(gets, 1); assert.equal(f.calls, 1);
  assert.deepEqual(await (await f.submit()).json(), { status: 'sent', issueNumber: 42 }); assert.equal(f.calls, 1);
});

test('a missing GitHub marker remains held and does not authorize a duplicate issue', async () => {
  const f = await fixture(async () => { throw new Error('Lost reply'); }); await f.submit();
  const { FeedbackLedger } = await import('../services/feedback-relay/src/worker.mjs');
  const ledger = new FeedbackLedger({ storage: f.storage }, f.env, async () => Response.json([]));
  const result = await ledger.fetch(new Request('https://ledger/reconcile', { method: 'POST', body: JSON.stringify({ id: 'fb-123456789012' }) }));
  assert.deepEqual(await result.json(), { status: 'needs-review' }); assert.equal(f.calls, 1);
});
