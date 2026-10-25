# Batch 5: feedback relay and paid AI proposals

25 October 2026. **Design only; awaiting owner sign-off.** No Worker, account, secret, proxy or billing infrastructure has been created. Recommended order: approve and deliver S1 first, then approve a private S3 pilot before enabling purchases.

## S1 — feedback without a reader's GitHub token

Use a Cloudflare Worker in the owner's account, targeting one fixed private feedback repository. Store its GitHub credential as a [Worker secret](https://developers.cloudflare.com/workers/configuration/secrets/). A repository-scoped fine-grained token needs only **Issues: write**; a GitHub App installation credential is an alternative if this expands. [GitHub's create-issue endpoint](https://docs.github.com/en/rest/issues/issues#create-an-issue) supports both.

The app retains its offline queue and sends a report UUID, type, book/chapter/pair references, selected context and the reader's note. It must not upload the vocabulary vault, conversation history or credentials. The server fixes the repository, permitted labels and issue format; clients cannot supply arbitrary GitHub destinations.

A public endpoint needs abuse protection: CORS alone is not authentication. For a private beta, use invitation-based access; for public anonymous feedback, verify a challenge server-side before issuing a short-lived submission permit. Later this can reuse S3 account/device authentication. Proposed starting limits are 20 KB per report and ten reports per device per day, with a broad IP backstop that accommodates shared networks. These are configurable proposals.

Persist each report ID and payload hash before submission. The app receives an accepted receipt and can query delivery status. A repeated ID with different content is rejected. GitHub creation and local persistence cannot share an atomic transaction: if a timeout leaves the outcome unknown, reconcile a hidden report marker before trying again. Keep unresolved reports pending for review rather than blindly creating duplicates. Logs hold identifiers and status, not report bodies or secrets; retention needs an owner decision.

After an owner-run end-to-end test, switch the app to the relay and remove the repository/token fields. Preserve queued reports. Never transfer existing client GitHub tokens to the relay. The owner creates the Worker and injects the secret in their own account after approval; no credential should be pasted into chat or committed.

## S3 — hosted AI with accounts and credits

Use a Cloudflare Worker as a policy gateway, with the owner's OpenAI key in a secret. OpenAI explicitly requires keys to remain out of client applications: [API authentication](https://developers.openai.com/api/reference/overview). The gateway permits named actions—explanation, conversation, word meaning, story and voice—with server-controlled models, prompts, lengths and output limits. It is not an unrestricted API forwarding service.

Paid balances belong to recoverable accounts, not an installation ID. Recommend Sign in with Apple for native release, with a compatible web sign-in/recovery approach agreed before implementation. After account authentication, register a device public key; its private key stays on the device. Authenticate requests with signed challenges or short-lived tokens bound to that device, with nonce/replay checks and device revocation. Device registration alone is not evidence that a user is legitimate; enrollment and account recovery also need limits.

Keep authoritative balances, reservations and request records in one SQLite-backed Durable Object per account. [Durable Object transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) support atomic local changes; network requests must occur outside those transactions. Cloudflare's [edge rate limiter](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) is approximate and location-based, so use it for abuse reduction, not credit accounting. Starting proposals: ten text requests, thirty voice requests and one story request per minute, with two concurrent operations per account. The owner must set an overall spend ceiling and alerts; reserve budget before dispatch rather than assuming a vendor alert stops spending.

### Charging and failure handling

Show a fixed credit quote before each action. Pack values and action prices require a cost model and owner approval; this proposal sets no currency prices. Listening should quote a selected range and cap its spend, with no hidden paid prefetch. Playing an existing local clip costs no new credits.

1. Atomically reserve the quoted credits using a unique client request ID, payload hash and quote version. A repeated request returns its existing status/result.
2. Call the provider outside the database transaction, within server limits.
3. Retain the successful result and settle the reservation once. Failed/cancelled work releases the reader's reservation; the proposed policy is that the owner absorbs unavoidable provider costs, with cancellation abuse limits.
4. If the provider outcome is unknown, do not automatically submit again. Reconcile where supported; otherwise release the reader's credits if no result can be supplied and conservatively count possible provider expenditure against the owner's budget. Do not assume every endpoint supports idempotent retries.

Account and overall budget reservations need a coordinated reserve/compensate protocol, so parallel calls cannot spend the same balance or exceed the owner's cap. Repeated delivery of a retained result must never debit twice.

### Buying and recovering credits

For native iOS, propose consumable StoreKit credit packs. Apple's [review guidelines, section 3.1.1](https://developer.apple.com/app-store/review/guidelines/) normally require in-app purchase for digital functionality and say purchased credits must not expire. Regional/storefront exceptions exist; confirm the intended distribution plan before release. A web checkout or external-purchase link is a separate decision, not included in this build proposal.

Verify signed transactions server-side, including app, product, environment, transaction ID and account association. Deduplicate transaction IDs before granting credits. Use [App Store Server API](https://developer.apple.com/documentation/appstoreserverapi) and verified [Server Notifications V2](https://developer.apple.com/documentation/appstoreservernotifications/receiving-app-store-server-notifications) to reconcile purchases and refunds. Define refund treatment for already-spent credits before launch. The server ledger restores the remaining balance after sign-in on a new device; installation-local storage or a generic Restore Purchases button is insufficient as the balance authority.

### Migration and acceptance

Keep explicit BYOK mode available during the private beta until hosted AI is reliable. A reader must opt into hosted credits before any charge. Never forward a reader's OpenAI key through the proxy or erase it automatically. Preserve books, progress, saved vocabulary and audio; cached reading remains offline-capable. Existing automatic voice generation must not silently become a paid credit operation.

Before launch, verify: concurrent reservations cannot overspend; request retries and purchase callbacks settle once; invalid signatures, replayed nonces and revoked devices fail; cancellation/provider errors/refunds recover correctly; a fresh device recovers its account balance; and credentials never enter client bundles, backups or logs. Start with owner-issued test credits and no real purchases.

## Decisions requested before building

- Approve S1 first, and identify the owner's Cloudflare account/domain and fixed feedback repository. Choose private invitations or public challenge protection and retention.
- Approve or revise S3 architecture; choose account/recovery methods, native/web rollout and storefronts.
- Set initial spend ceiling, free allowance, pricing and refund/cancellation policies before enabling charges.
- Choose the app name separately from [the six options](app-name-options.md). No name has been selected.

No Git history rewrite is proposed. Implementation of either service requires the owner's explicit approval, as requested in the QA handoff.
