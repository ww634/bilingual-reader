// Client-side tokens-per-minute throttle.
//
// On low OpenAI tiers (e.g. 30k TPM) we fire translation/alignment requests
// faster than the per-minute window allows, so the SDK's 429 retries can't
// keep up with sustained over-limit demand and a chapter drops. This paces
// requests BEFORE they're sent: a request waits until its estimated token
// cost fits under the limit within a rolling 60s window. After the call we
// reconcile the reservation with the real usage so the estimate self-corrects.
//
// Set the limit from the CLI (--tpm). Default leaves headroom under 30k.

const WINDOW_MS = 60_000;
let TPM_LIMIT = 27_000;

// Rolling log of { t: epoch ms, tokens } reservations within the window.
const reservations = [];

export function setTpmLimit(n) {
  if (Number.isFinite(n) && n > 0) TPM_LIMIT = n;
}

function usedInWindow(now) {
  while (reservations.length && now - reservations[0].t > WINDOW_MS) reservations.shift();
  return reservations.reduce((sum, r) => sum + r.tokens, 0);
}

/**
 * Block until `estTokens` fits under the limit, then reserve it.
 * Returns a handle (the reservation object) to pass to reconcile().
 */
export async function acquire(estTokens) {
  const est = Math.min(Math.max(estTokens || 0, 0), TPM_LIMIT);
  for (;;) {
    const now = Date.now();
    if (usedInWindow(now) + est <= TPM_LIMIT) {
      const r = { t: now, tokens: est };
      reservations.push(r);
      return r;
    }
    // Wait until the oldest reservation ages out of the window.
    const wait = WINDOW_MS - (now - reservations[0].t) + 50;
    await new Promise((res) => setTimeout(res, Math.max(wait, 250)));
  }
}

/** Replace a reservation's estimate with the actual token usage. */
export function reconcile(handle, actualTokens) {
  if (handle && Number.isFinite(actualTokens)) handle.tokens = actualTokens;
}

/** Estimate a chat request's token cost from its messages + output budget. */
export function estimateRequestTokens(messages, outputBudget = 1500) {
  const chars = JSON.stringify(messages || []).length;
  return Math.ceil(chars / 4) + outputBudget; // ~4 chars/token + expected output
}
