# Update state

Read ../AGENTS.md, previous `_state.json`, `_series.json`, the current beat, retained prose and the newly finalized chapter. Verify chapter id equals previous chapters_written+1, book_id matches, and catalog has the same chapter title/version/URL. Compare joined pair.hanzi to retained prose exactly. If anything is missing, repair registration without regenerating the chapter before advancing.

Write a concise private running_summary of events actually dramatized so far, compressing older material and retaining recent causality. Update character statuses (location, aims, relationships, injuries, knowledge), open_threads and seeds:{desc,planted_ch,paid}. Preserve unresolved seeds and original planted_ch; mark paid only when paid on the page. Do not leak future beat knowledge into the checkpoint.

Set last_ending to `[...prose].slice(-240).join('')` verbatim, including punctuation/whitespace. Set chapters_written to the finalized global chapter number. Keep the §5 schema: chapters_written,running_summary,last_ending,characters:[{name_english,status}],open_threads,seeds. Prepare a temporary JSON, parse and verify it, then rename atomically to `_state.json`.

On interrupted-run recovery, derive these facts from the existing finalized chapter; never re-author it. If already checkpointed, do not advance again. Repeat the write → encode → finalize → update-state loop only for the requested wave length. Report counts and reader artifact links without future spoilers.
