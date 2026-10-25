// No reader credentials or report bodies are persisted here. GitHub is the
// owner's private report store; the ledger retains hashes/status for deduping.
const LIMIT = 20 * 1024;
const idPattern = /^[a-zA-Z0-9_-]{12,80}$/;
const keyPattern = /^[a-zA-Z0-9_-]{43}$/; // 32 random bytes, base64url
const kinds = new Set(['translation', 'pinyin', 'words', 'audio', 'other']);
const json = (body, status = 200) => Response.json(body, { status });
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const digest = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))), b => b.toString(16).padStart(2, '0')).join('');
const text = (value, max, required = false) => {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, 'Invalid report.');
  return value;
};

export function normalizeReport(value) {
  if (!value || !idPattern.test(value.id) || !kinds.has(value.kind)) fail(400, 'Invalid report.');
  const s = value.selection;
  if (!s || !['fr', 'zh'].includes(s.language) || !Array.isArray(s.pairs) || s.pairs.length > 10) fail(400, 'Invalid selection.');
  // Explicit whitelist: local status, credentials and unrelated app data never
  // reach GitHub, even if a client accidentally sends its entire local record.
  return {
    id: value.id, kind: value.kind, message: text(value.message, 3000, true),
    createdAt: text(value.createdAt, 40, true), appVersion: text(String(value.appVersion ?? ''), 30),
    selection: {
      language: s.language, bookId: text(s.bookId, 160, true), chapterId: text(s.chapterId, 160, true),
      chapterTitle: text(s.chapterTitle, 240), script: text(s.script, 30),
      shown: text(s.shown, 2000), hanzi: text(s.hanzi, 2000), pinyin: text(s.pinyin, 2000),
      pairs: s.pairs.map(p => {
        if (!p || !Number.isSafeInteger(p.index) || p.index < 0) fail(400, 'Invalid sentence reference.');
        return { index: p.index, target: text(p.target, 3000), english: text(p.english, 3000), hanzi: text(p.hanzi, 3000), words: text(p.words, 3000) };
      }),
    },
  };
}

async function readJson(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) fail(415, 'Use JSON.');
  if (Number(request.headers.get('content-length')) > LIMIT) fail(413, 'Report is too large.');
  if (!request.body) fail(400, 'Missing report.');
  const reader = request.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > LIMIT) { await reader.cancel(); fail(413, 'Report is too large.'); }
      chunks.push(value);
    }
    const all = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all)); }
    catch { fail(400, 'Invalid JSON.'); }
  } finally { reader.releaseLock(); }
}

function cors(response, origin) {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Vary', 'Origin');
  headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, { status: response.status, headers });
}

// Injectable fetch is solely for local tests; the deployed entry point uses
// the platform fetch, never a client-supplied upstream or repository.
export function createWorker(upstream = fetch) {
  return {
    async fetch(request, env) {
      // Operator recovery is separate from browser traffic. A randomly generated
      // admin token is optional; without it the route is unavailable.
      if (new URL(request.url).pathname === '/admin/reconcile') {
        try {
          const supplied = request.headers.get('Authorization') || '';
          if (request.method !== 'POST' || !env.ADMIN_TOKEN || await digest(supplied) !== await digest(`Bearer ${env.ADMIN_TOKEN}`)) return json({ error: 'Not found.' }, 404);
          if (env.ENABLED !== 'true' || !env.GITHUB_TOKEN) fail(503, 'Feedback delivery is not ready.');
          const body = await readJson(request);
          if (!idPattern.test(body.id)) fail(400, 'Invalid report ID.');
          return await env.REPORTS.get(env.REPORTS.idFromName('feedback-v1')).fetch(new Request('https://ledger/reconcile', { method: 'POST', body: JSON.stringify({ id: body.id }) }));
        } catch { return json({ error: 'Reconciliation unavailable.' }, 503); }
      }
      if (request.headers.get('Origin') !== env.APP_ORIGIN) return json({ error: 'Origin not allowed.' }, 403);
      try {
        const url = new URL(request.url);
        if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), env.APP_ORIGIN);
        if (env.ENABLED !== 'true' || !env.GITHUB_TOKEN || !env.TURNSTILE_SECRET || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPO || '')) fail(503, 'Feedback delivery is not ready. Your report can stay saved on this device.');
        if (!((request.method === 'POST' && url.pathname === '/reports') || (request.method === 'GET' && /^\/reports\/[a-zA-Z0-9_-]{12,80}$/.test(url.pathname)))) fail(404, 'Not found.');
        const ledger = env.REPORTS.get(env.REPORTS.idFromName('feedback-v1'));
        let response;
        if (request.method === 'GET') {
          const key = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
          if (!keyPattern.test(key)) fail(401, 'Missing receipt key.');
          response = await ledger.fetch(new Request('https://ledger/status', {
            method: 'POST', body: JSON.stringify({ id: url.pathname.split('/')[2], keyHash: await digest(key) }),
          }));
        } else {
          const body = await readJson(request);
          const report = normalizeReport(body.report);
          if (!keyPattern.test(body.receiptKey) || !idPattern.test(body.deviceId)) fail(400, 'Invalid receipt or device.');
          const token = text(body.turnstileToken, 2048, true);
          const ip = request.headers.get('CF-Connecting-IP');
          if (!ip) fail(503, 'Feedback delivery is not ready.');
          const challenge = await upstream('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
            body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
          });
          if (!challenge.ok) fail(503, 'Verification is unavailable. Please try later.');
          const verified = await challenge.json();
          if (!verified.success || verified.hostname !== env.TURNSTILE_HOSTNAME || verified.action !== 'feedback' || verified.cdata !== report.id) fail(403, 'Please verify this feedback submission again.');
          const day = new Date().toISOString().slice(0, 10);
          const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TURNSTILE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
          const ipHash = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(`${day}:${ip}`))), b => b.toString(16).padStart(2, '0')).join('');
          response = await ledger.fetch(new Request('https://ledger/submit', {
            method: 'POST', body: JSON.stringify({ report, hash: await digest(JSON.stringify(report)), keyHash: await digest(body.receiptKey), deviceHash: await digest(body.deviceId), ipHash, day }),
          }));
        }
        return cors(response, env.APP_ORIGIN);
      } catch (error) {
        return cors(json({ error: error.status ? error.message : 'Feedback delivery is unavailable. Please try later.' }, error.status || 503), env.APP_ORIGIN);
      }
    },
  };
}

export class FeedbackLedger {
  constructor(ctx, env, upstream = fetch) {
    this.storage = ctx.storage; this.env = env;
    // workerd's global fetch requires its original receiver, unlike Node's.
    this.upstream = (input, init) => upstream(input, init);
  }

  async fetch(request) {
    const input = await request.json();
    const key = `report:${input.id || input.report.id}`;
    if (new URL(request.url).pathname === '/reconcile') {
      const row = await this.storage.get(key);
      if (!row) return json({ error: 'Receipt not found.' }, 404);
      if (row.status === 'sent') return this.result(row);
      const since = new Date(row.at - 300000).toISOString();
      // A match can confirm delivery; absence is never proof of non-delivery.
      // Bound work and leave unresolved reports held. No recovery POST exists.
      for (let page = 1; page <= 10; page++) {
        const response = await this.upstream(`https://api.github.com/repos/${this.env.GITHUB_REPO}/issues?state=all&sort=created&direction=asc&since=${encodeURIComponent(since)}&per_page=100&page=${page}`, {
          headers: { Authorization: `Bearer ${this.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'reader-feedback-relay', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return json({ error: 'Reconciliation unavailable.' }, 503);
        const issues = await response.json();
        if (!Array.isArray(issues)) return json({ error: 'Reconciliation unavailable.' }, 503);
        const found = issues.find(issue => !issue.pull_request && issue.body?.startsWith(`<!-- reader-report:${input.id} -->\n`) && Number.isSafeInteger(issue.number));
        if (found) {
          await this.storage.transaction(async tx => {
            const current = await tx.get(key);
            current.status = 'sent'; current.issueNumber = found.number;
            await tx.put(key, current);
          });
          return json({ status: 'sent', issueNumber: found.number });
        }
        if (issues.length < 100) break;
      }
      return json({ status: 'needs-review' }, 202);
    }
    if (new URL(request.url).pathname === '/status') {
      const row = await this.storage.get(key);
      if (!row || row.keyHash !== input.keyHash) return json({ error: 'Receipt not found.' }, 404);
      return this.result(row);
    }
    const claim = await this.storage.transaction(async tx => {
      const old = await tx.get(key);
      if (old) return { old };
      // Strict daily counters, updated atomically with the report claim. IPs
      // are salted per day and never stored in plaintext.
      const counters = [
        [`quota:${input.day}:device:${input.deviceHash}`, 10],
        [`quota:${input.day}:ip:${input.ipHash}`, 100],
        [`quota:${input.day}:global`, 1000],
      ];
      const values = await Promise.all(counters.map(async ([id, limit]) => [id, limit, (await tx.get(id)) || 0]));
      if (values.some(([, limit, count]) => count >= limit)) return { limited: true };
      for (const [id, , count] of values) await tx.put(id, count + 1);
      const row = { hash: input.hash, keyHash: input.keyHash, status: 'sending', at: Date.now() };
      await tx.put(key, row);
      return { row };
    });
    if (claim.limited) return json({ error: 'Feedback limit reached. Your report can stay saved; try tomorrow.' }, 429);
    if (claim.old) {
      if (claim.old.hash !== input.hash || claim.old.keyHash !== input.keyHash) return json({ error: 'Report ID already used.' }, 409);
      return this.result(claim.old);
    }
    // Claim persisted before any external side effect. Crashes/timeouts must
    // never cause automatic reposting. Owners reconcile the marker manually.
    if (!await this.storage.getAlarm()) await this.storage.setAlarm(Date.now() + 86400000);
    const row = claim.row;
    try {
      const report = input.report;
      const response = await this.upstream(`https://api.github.com/repos/${this.env.GITHUB_REPO}/issues`, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${this.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'reader-feedback-relay', 'X-GitHub-Api-Version': '2022-11-28' },
        body: JSON.stringify({ title: `[${report.kind}] ${report.selection.bookId} ${report.selection.chapterId}`.replace(/[\r\n]/g, ' ').slice(0, 200), body: `<!-- reader-report:${report.id} -->\n\nReader report (untrusted reader text):\n\n\`\`\`json\n${JSON.stringify(report, null, 2).replace(/`/g, '\\u0060')}\n\`\`\`` }),
      });
      if (response.status === 201) {
        const issue = await response.json();
        if (!Number.isSafeInteger(issue.number) || issue.number < 1) throw new Error('Invalid issue receipt');
        row.status = 'sent'; row.issueNumber = issue.number;
      } else {
        // Even errors are held for owner review: conservative delivery is
        // preferable to silently duplicating an issue after an uncertain POST.
        row.status = 'needs-review';
      }
    } catch { row.status = 'needs-review'; }
    await this.storage.put(key, row);
    return this.result(row);
  }

  result(row) {
    const status = row.status === 'sending' && Date.now() - row.at > 120000 ? 'needs-review' : row.status;
    return json({ status, ...(row.issueNumber ? { issueNumber: row.issueNumber } : {}) }, status === 'sent' ? 200 : 202);
  }

  async alarm() {
    // Paginate daily counter cleanup; retain small report tombstones so an old
    // offline queue can never recreate a previously delivered report.
    const today = new Date().toISOString().slice(0, 10);
    let startAfter;
    for (;;) {
      const page = await this.storage.list({ prefix: 'quota:', limit: 500, ...(startAfter ? { startAfter } : {}) });
      if (!page.size) break;
      const expired = [...page.keys()].filter(key => key.slice(6, 16) < today);
      if (expired.length) await this.storage.delete(expired);
      startAfter = [...page.keys()].at(-1);
      if (page.size < 500) break;
    }
    await this.storage.setAlarm(Date.now() + 86400000);
  }
}

export default createWorker();
