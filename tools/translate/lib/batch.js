// Thin wrapper around OpenAI's Batch API.
//
// A "request" here is { custom_id, body } where body is exactly what you'd
// pass to chat.completions.create. We serialise them to JSONL, upload, create
// a batch, poll to completion, and collect results into a Map keyed by
// custom_id. The custom_id is our join key back to the chapter/sub-batch.
//
// Why batch: ~50% cheaper, separate (large) rate limits, and server-side — so
// a local process being killed mid-run doesn't lose work; we persist the
// batch id and just poll again.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TERMINAL = new Set(["completed", "failed", "expired", "cancelled"]);

/** Serialise [{custom_id, body}] to a JSONL string for the batch input file. */
export function buildJsonl(requests) {
  return requests
    .map((r) => JSON.stringify({
      custom_id: r.custom_id,
      method: "POST",
      url: "/v1/chat/completions",
      body: r.body,
    }))
    .join("\n") + "\n";
}

/** Upload a JSONL string + create a batch. Returns the batch object. */
export async function submitBatch(client, jsonl, { label = "batch" } = {}) {
  const tmp = path.join(os.tmpdir(), `bilingual-${label}-${Date.now()}.jsonl`);
  fs.writeFileSync(tmp, jsonl);
  try {
    const file = await client.files.create({
      file: fs.createReadStream(tmp),
      purpose: "batch",
    });
    return await client.batches.create({
      input_file_id: file.id,
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
    });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

/**
 * Poll a batch until it reaches a terminal state. Calls onTick(batch) on each
 * poll so the caller can show progress. Interval backs off 15s → 60s.
 */
export async function pollBatch(client, batchId, { onTick } = {}) {
  let interval = 15000;
  for (;;) {
    const b = await client.batches.retrieve(batchId);
    if (onTick) onTick(b);
    if (TERMINAL.has(b.status)) return b;
    await new Promise((r) => setTimeout(r, interval));
    interval = Math.min(interval + 15000, 60000);
  }
}

/**
 * Download a completed batch's outputs into a Map<custom_id, result>, where
 * result is { ok, body?, error? }. Reads both the success output file and the
 * error file (failed lines).
 */
export async function collectBatch(client, batch) {
  const out = new Map();
  const readJsonl = async (fileId) => {
    if (!fileId) return [];
    const text = await (await client.files.content(fileId)).text();
    return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };
  for (const line of await readJsonl(batch.output_file_id)) {
    const body = line.response?.body;
    const ok = line.response?.status_code === 200 && body && !body.error;
    out.set(line.custom_id, ok ? { ok: true, body } : { ok: false, error: line.response?.body || "non-200" });
  }
  for (const line of await readJsonl(batch.error_file_id)) {
    out.set(line.custom_id, { ok: false, error: line.error || line.response?.body || "error" });
  }
  return out;
}

/** Pull the assistant message content out of a collected chat-completion body. */
export function contentOf(result) {
  return result?.ok ? (result.body.choices?.[0]?.message?.content || "") : "";
}

/** Sum prompt/completion tokens across a collected Map (for cost reporting). */
export function usageOf(resultMap) {
  let prompt_tokens = 0, completion_tokens = 0;
  for (const r of resultMap.values()) {
    const u = r?.body?.usage;
    if (u) { prompt_tokens += u.prompt_tokens || 0; completion_tokens += u.completion_tokens || 0; }
  }
  return { prompt_tokens, completion_tokens };
}
