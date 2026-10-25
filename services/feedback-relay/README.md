# Feedback relay: owner setup and activation

Approved for implementation on 25 October 2026. Source and local tests are prepared; **not deployed or connected to the reader yet**. Hosted AI and billing are separate, unapproved work. This service does not call OpenAI.

## What to set up, and why

| Item | Purpose | Public or secret? |
| --- | --- | --- |
| Cloudflare account with Workers available | Runs the small feedback API instead of putting GitHub access in readers' browsers. | Account stays yours. |
| Worker `reader-feedback-relay` | Receives reports at its `workers.dev` URL. A custom domain is optional. | URL is public. This is a service identifier, not an app-name decision. |
| SQLite Durable Object binding `REPORTS` | Remembers report receipts and strict daily counters, preventing duplicates and races. The supplied Wrangler configuration creates the namespace/migration. No D1, KV namespace, R2 bucket or queue needs manual creation. | Server-side metadata. |
| Turnstile widget, Managed mode, hostname `ww634.github.io` | Deters automated spam before the service can create GitHub issues. Server verification is mandatory. | Site key public; secret key private. |
| GitHub fine-grained token for `ww634/reader-feedback` only | Lets the server create issues in the existing private feedback repository. Grant **Issues: read and write**, with no extra repository access. | Secret; never give it to readers or put it in this repo/chat. |
| Optional random `ADMIN_TOKEN` | Allows the owner to reconcile an uncertain delivery without risking a duplicate. Generate at least 32 random bytes and retain it securely. | Secret; never used by the app. |

Cloudflare currently supports SQLite Durable Objects on the Free plan; this small beta need not start on a paid plan. Free quotas still apply and this is not a guarantee of unlimited or zero-cost usage: [Durable Object plans](https://developers.cloudflare.com/durable-objects/platform/pricing/). Do not enable a paid plan merely for this setup without checking its terms and limits.

## Owner steps

1. Sign in to your Cloudflare account and open **Workers & Pages**. Set up a `workers.dev` subdomain if you do not already have one. The deployment below creates/updates the Worker in the account you select; a separate Pages project is unnecessary. You can create an initial Worker named `reader-feedback-relay` in the dashboard if preferred, but deploy this complete project before enabling it.
2. Open **Turnstile → Add widget**. Use a descriptive widget name, Managed mode, and hostname `ww634.github.io` (no scheme or `/bilingual-reader/app/` path). Leave pre-clearance off. Keep the secret private and note the public site key. [Cloudflare widget setup](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/).
3. In GitHub, create the repository-scoped fine-grained token described above. Keep an expiry/rotation reminder. If the repository belongs to an organization, its token approval policy also applies. [GitHub issue permissions](https://docs.github.com/en/rest/issues/issues#create-an-issue).
4. In your terminal, from this repository, run:

   ```sh
   cd services/feedback-relay
   npm ci
   npx wrangler login
   npm run check
   npm run deploy
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put TURNSTILE_SECRET
   npx wrangler secret put ADMIN_TOKEN
   ```

   Select your account during login. Each `secret put` prompts privately; paste only that secret, not a whole `.env` file. `ADMIN_TOKEN` is optional but recommended for recovery. The initial deployment is deliberately disabled (`ENABLED=false`), so it cannot create issues. Secrets must be [Worker secret bindings](https://developers.cloudflare.com/workers/configuration/secrets/), never plaintext `vars`.
5. Confirm the nonsecret configuration in `wrangler.jsonc`: `APP_ORIGIN=https://ww634.github.io`, `TURNSTILE_HOSTNAME=ww634.github.io`, and the fixed GitHub repository. The origin intentionally has no path; GitHub Pages projects share it. Turnstile additionally binds submissions to the `feedback` action and specific report ID.
6. Send back only the **Worker URL and public Turnstile site key**. No Cloudflare API token, GitHub token or Turnstile secret is needed in chat. These two public values let the app integration be completed and previewed.

The owner needs to complete login/account/secret setup. Do not create a broad Cloudflare API token or grant the app general account access for this service. No domain registration or DNS transfer is required.

## App activation still to complete

The reader remains on its existing private-installation feedback path for now. Once the owner's URL/site key are available:

- Add the public relay configuration and render Turnstile on an explicit feedback send/retry action, using `action: 'feedback'` and `cData: report.id`. Tokens are short-lived and single-use; do not persist them or use background retries to invent a fresh verification. [Server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
- Generate a 32-byte random base64url receipt key per report, plus a random installation ID. Persist these with the existing offline queue. Keep report content immutable after first submission, including the app version. Existing `fb-…` IDs are supported. Do not forward old GitHub tokens. Project only the whitelisted report fields.
- POST `{report, receiptKey, deviceId, turnstileToken}` to `/reports`. Poll `/reports/ID` with `Authorization: Bearer RECEIPT_KEY` after uncertain client responses. `sent` means delivered; `sending` means wait; `needs-review` means hold for owner recovery. A 429/503 keeps the report locally with a truthful retry message. A 409 needs investigation, not silent creation of a new ID.
- Hide repo/token settings after migration; preserve pending reports and study data. Exclude receipt keys/device identifiers from public exports. Add the widget's external script and API origins to any future CSP deliberately; never cache Turnstile responses in the service worker.
- Preview the actual reader at phone width: send, offline save, online retry, cancelled/failed verification, duplicate taps, quota error, Settings status and a migrated pending report. Run existing tests and publication checks. All GitHub calls stay mocked until the owner is ready for the live smoke test.
- Enable the Worker (`ENABLED=true`, redeploy), perform one explicitly authorized test report to the private repository, and verify its receipt and single issue before publishing the client migration through the gated Pages workflow.

Do not claim production completion until this owner-account smoke test and reader migration pass. The Worker is deployed separately from Pages; its source/configuration is not included in the static app artifact.

## Operations and limitations

Defaults: 20 KB submission body; ten reports per installation/day, 100 per IP/day, 1,000 total/day. Installation IDs can be reset, so they are an abuse signal, not authentication. Turnstile and the broader limits are also required. Raw IPs are used for challenge validation but not stored; daily salted hashes identify quota buckets. Shared-network users can hit the IP limit. Additional Cloudflare traffic rules may be appropriate before a wider launch; these application limits do not bound every rejected request's platform cost.

Only normalized report content is forwarded to GitHub. The Durable Object stores hashes, delivery state and issue number, not report text or tokens. Counter keys expire through daily alarm cleanup. Small report tombstones persist to prevent old offline queues creating duplicates; deleting them requires an explicit migration policy. Reports remain in the owner's private GitHub repository under its retention/access policy. Infrastructure providers still process request metadata; application request logging is disabled and the service emits no body/credential logs.

An uncertain GitHub response is never automatically reposted. For recovery, call `POST /admin/reconcile` with JSON `{"id":"REPORT_ID"}` and the operator's `Authorization: Bearer ADMIN_TOKEN`. Use a private API client; do not put secrets in a URL or shell command history. This only reads GitHub issues (up to ten pages) and marks an exact marker match delivered. If no match is found, it remains held for review; absence is not proof that an issue was never created. The route is disabled when `ADMIN_TOKEN` is absent. Keep this key out of browser code. A confirmed non-delivery requires a deliberate operator recovery procedure before resubmission; no automatic reset/repost endpoint is provided.

Emergency stop: set `ENABLED=false` and redeploy, or disable the Worker. Reports remain queued on readers' devices. Rotate the relevant secret if compromised. Re-enable only after verifying repository scope and a single-report test.

Local verification: `node --test tests/feedback-relay.cjs` from the repository root exercises validation, origin/challenge binding, duplicates, quota races, receipt secrecy, uncertain delivery and recovery using fake upstreams and transactional in-memory storage. Inside this service directory, `npm run test:runtime` also exercises concurrent delivery and receipt lookup in actual local workerd with SQLite Durable Objects, intercepting all upstreams. `npm run check` checks the Wrangler bundle/config. These checks pass and run in CI without deploying. They do not substitute for an owner-account smoke test; no live issue is created by them. The development-tool lockfile overrides Undici to patched 7.30.1; npm audit reports zero vulnerabilities at this checkpoint.
