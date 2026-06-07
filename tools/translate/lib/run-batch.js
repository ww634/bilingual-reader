// Whole-book orchestrator for --batch mode.
//
// Instead of hundreds of sequential sync calls, we submit a few big OpenAI
// Batch jobs and collect them: translate → (gap-fill) → romanize → align →
// assemble. Each round's batch id is persisted to a manifest so a re-run
// resumes by polling an in-flight batch rather than resubmitting (the whole
// point: the work runs server-side, immune to the local process dying).
//
// Reuses the EXACT prompt/schema builders + validation/romanize/echo-match
// helpers from the sync path, so output is identical — only the transport
// differs.

import fs from "node:fs";
import path from "node:path";
import {
  buildTranslateBody, parseTranslationItems, assignTranslationItems, _normEcho,
  validatePairs, MAX_CLAUSES_PER_CALL,
} from "./translate.js";
import { buildAlignBody, applyAlignmentChunks, DEFAULT_BATCH_SIZE } from "./align.js";
import { romanize } from "./romanize.js";
import { buildJsonl, submitBatch, pollBatch, collectBatch, contentOf } from "./batch.js";

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const grn = (s) => `\x1b[32m${s}\x1b[0m`;
const ylw = (s) => `\x1b[33m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function loadManifest(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}
function saveManifest(p, m) {
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
}

/**
 * Submit a round, or resume an in-flight one from the manifest. `requests` is
 * [{custom_id, body}]. Returns the collected Map<custom_id,result>. Persists
 * the batch id immediately so an interruption resumes by polling.
 */
async function submitOrResume(client, manifest, manifestPath, phase, requests, label) {
  manifest[phase] = manifest[phase] || {};
  let batchId = manifest[phase].batchId;
  if (!batchId) {
    if (requests.length === 0) { manifest[phase].status = "empty"; saveManifest(manifestPath, manifest); return new Map(); }
    process.stdout.write(dim(`   submitting ${label} batch (${requests.length} requests)…\n`));
    const batch = await submitBatch(client, buildJsonl(requests), { label });
    batchId = batch.id;
    manifest[phase] = { batchId, status: batch.status };
    saveManifest(manifestPath, manifest);
  } else {
    process.stdout.write(dim(`   resuming ${label} batch ${batchId}…\n`));
  }
  const done = await pollBatch(client, batchId, {
    onTick: (b) => {
      const rc = b.request_counts || {};
      process.stdout.write(dim(`   ${label}: ${b.status} ${rc.completed || 0}/${rc.total || 0}\r`));
    },
  });
  process.stdout.write("\n");
  manifest[phase].status = done.status;
  saveManifest(manifestPath, manifest);
  if (done.status !== "completed") {
    throw new Error(`${label} batch ${batchId} ended ${done.status}. Re-run with --poll to retry, or inspect at platform.openai.com.`);
  }
  return collectBatch(client, done);
}

/**
 * @param ctx {
 *   client, model, bookId, bookDir, canonicalNames,
 *   chapters: [{ chapterId, englishTitle, fullText, clauses: string[],
 *                title: {english,hanzi,target}, synopsis }],
 *   alignment: boolean,
 *   writeChapter: (chapterId, pairs, title, complete) => Promise,
 *   addUsage: (usage, bucket) => void,
 * }
 */
export async function runBookBatch(ctx) {
  const { client, model, bookDir, chapters, canonicalNames, alignment } = ctx;
  const manifestPath = path.join(bookDir, ".batch-state.json");
  const manifest = loadManifest(manifestPath);

  // ── Round 1: translate (one request per chapter clause-batch) ──
  console.log("\n" + bold("4.") + " Batch translating…");
  const trReqs = [];
  const planByChapter = new Map(); // chapterId -> [{batchIdx, clauses, startClause}]
  for (const ch of chapters) {
    const batches = chunk(ch.clauses, MAX_CLAUSES_PER_CALL);
    const plan = [];
    let start = 0;
    batches.forEach((clauses, bi) => {
      plan.push({ batchIdx: bi, clauses, startClause: start });
      trReqs.push({
        custom_id: `tr|${ch.chapterId}|${bi}`,
        body: buildTranslateBody(clauses, {
          model, fullText: ch.fullText, englishTitle: ch.englishTitle, canonicalNames,
          batchPosition: { index: bi + 1, total: batches.length, startClause: start + 1 },
        }),
      });
      start += clauses.length;
    });
    planByChapter.set(ch.chapterId, plan);
  }
  const trResults = await submitOrResume(client, manifest, manifestPath, "translate", trReqs, "translate");

  // Assemble translations per chapter; collect gaps (clauses with no match).
  const hanByChapter = new Map(); // chapterId -> (string|null)[]  per clause
  const gapReqs = [];
  for (const ch of chapters) {
    const hanForClause = new Array(ch.clauses.length).fill(null);
    const normClauses = ch.clauses.map(_normEcho);
    for (const { batchIdx, clauses, startClause } of planByChapter.get(ch.chapterId)) {
      const res = trResults.get(`tr|${ch.chapterId}|${batchIdx}`);
      const items = parseTranslationItems(contentOf(res));
      // pending = global clause indices covered by this sub-batch
      const pending = clauses.map((_, k) => startClause + k);
      assignTranslationItems(items, pending, normClauses, hanForClause);
    }
    hanByChapter.set(ch.chapterId, { hanForClause, normClauses });
    const missing = hanForClause.map((h, i) => (h ? -1 : i)).filter((i) => i >= 0);
    if (missing.length) {
      // One gap request per chapter covering just the unmatched clauses.
      gapReqs.push({
        custom_id: `trg|${ch.chapterId}`,
        body: buildTranslateBody(missing.map((i) => ch.clauses[i]), {
          model, fullText: ch.fullText, englishTitle: ch.englishTitle, canonicalNames, coverageRetry: true,
        }),
      });
    }
  }

  // ── Round 1b: gap-fill (only chapters with misses) ──
  if (gapReqs.length) {
    console.log(dim(`   ${gapReqs.length} chapter(s) had unmatched clauses — gap-fill batch…`));
    const gapResults = await submitOrResume(client, manifest, manifestPath, "translate_gap", gapReqs, "gap-fill");
    for (const ch of chapters) {
      const res = gapResults.get(`trg|${ch.chapterId}`);
      if (!res) continue;
      const { hanForClause, normClauses } = hanByChapter.get(ch.chapterId);
      const pending = hanForClause.map((h, i) => (h ? -1 : i)).filter((i) => i >= 0);
      assignTranslationItems(parseTranslationItems(contentOf(res)), pending, normClauses, hanForClause);
    }
  }

  // ── Romanize (local, no API) + build pairs ──
  for (const ch of chapters) {
    const { hanForClause } = hanByChapter.get(ch.chapterId);
    ch.pairs = ch.clauses.map((c, i) => {
      const hanzi = hanForClause[i] || "";
      return { english: c, hanzi, target: romanize(hanzi) };
    });
    const v = validatePairs(ch.clauses, ch.pairs);
    const filled = ch.pairs.filter((p) => p.hanzi).length;
    console.log(filled === ch.pairs.length
      ? grn(`   ✓ ${ch.chapterId}: ${ch.pairs.length} pairs translated`)
      : ylw(`   ⚠ ${ch.chapterId}: ${filled}/${ch.pairs.length} clauses translated (${ch.pairs.length - filled} unmatched)`));
    // Persist translations now (alignment_complete=false) so align is resumable.
    if (alignment) await ctx.writeChapter(ch.chapterId, ch.pairs, ch.title, false);
  }

  // ── Round 2: align (one request per chapter pair-batch) ──
  if (alignment) {
    console.log("\n" + bold("5.") + " Batch aligning…");
    const alReqs = [];
    const alPlan = new Map(); // chapterId -> [{batchIdx, startPair, pairs}]
    for (const ch of chapters) {
      const batches = chunk(ch.pairs, DEFAULT_BATCH_SIZE);
      const plan = [];
      let start = 0;
      batches.forEach((pairs, bi) => {
        plan.push({ batchIdx: bi, startPair: start, count: pairs.length });
        alReqs.push({ custom_id: `al|${ch.chapterId}|${bi}`, body: buildAlignBody(pairs, { model, englishTitle: ch.englishTitle }) });
        start += pairs.length;
      });
      alPlan.set(ch.chapterId, plan);
    }
    const alResults = await submitOrResume(client, manifest, manifestPath, "align", alReqs, "align");

    for (const ch of chapters) {
      for (const { batchIdx, startPair, count } of alPlan.get(ch.chapterId)) {
        const res = alResults.get(`al|${ch.chapterId}|${batchIdx}`);
        if (!res) continue;
        let parsed;
        try { parsed = JSON.parse(contentOf(res)); } catch { continue; }
        const slice = ch.pairs.slice(startPair, startPair + count);
        applyAlignmentChunks(parsed.alignments, slice);
        for (const a of parsed.alignments || []) {
          const local = a.pair_index;
          if (Number.isInteger(local) && slice[local]) ch.pairs[startPair + local].alignment = a.chunks;
        }
      }
      const aligned = ch.pairs.filter((p) => Array.isArray(p.alignment) && p.alignment.length).length;
      console.log(grn(`   ✓ ${ch.chapterId}: aligned ${aligned}/${ch.pairs.length} pairs`));
    }
  }

  // ── Assemble: final write (alignment_complete=true) ──
  for (const ch of chapters) {
    await ctx.writeChapter(ch.chapterId, ch.pairs, ch.title, true);
  }

  // Done — clear the manifest so a future run of the same book starts fresh.
  try { fs.unlinkSync(manifestPath); } catch {}
}
