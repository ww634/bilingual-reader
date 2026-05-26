# `tools/translate` — English → Bilingual Chapter

CLI that takes an English `.docx` (or `.txt` / `.md`) and produces:

- `content/chapters/<id>.json` — paired pinyin/English clauses
- `content/covers/<id>.svg` — auto-generated styled cover
- `content/library.json` — updated catalog entry

The reader PWA then sees the new chapter on its next online launch.

## One-time setup

```bash
cd "tools/translate"
npm install
```

**Set your OpenAI API key.** The key lives in a `.env` file inside this directory — scoped to just this tool, never touches your global shell, never gets committed to git.

```bash
# from tools/translate/
cp .env.example .env
# then open .env in any editor and paste your real key:
# OPENAI_API_KEY=sk-...
```

Get a key at <https://platform.openai.com/api-keys>. Top up a few dollars of credit at <https://platform.openai.com/settings/organization/billing>.

The tool auto-loads this `.env` on startup (via Node's built-in `process.loadEnvFile`). If you'd rather export the key in your shell (e.g. you keep all keys in `~/.zshrc`), that still works — a shell-exported `OPENAI_API_KEY` overrides the `.env` value.

**Security note:** `.env` is gitignored at both the repo root and inside `tools/translate/`. You'd have to actively force-add it to leak the key. The `.env.example` template *is* committed so the setup is reproducible.

## Basic usage

From the repo root:

```bash
node tools/translate \
  --in path/to/chapter2002.docx \
  --id ch-2002 \
  --title "Chapter 2002: The Next Bit"
```

The tool will:

1. Read and clean the input file (strip page numbers, repeated headers, collapse whitespace).
2. Show you a 400-char preview and ask `Cleaned text look right? [y/N]`.
3. Split into ~3–12-word clauses.
4. Print a cost estimate and ask `Proceed with API call? [y/N]`.
5. Call OpenAI (gpt-4o by default).
6. Validate output (count matches input, tone marks present, no Han characters).
7. Write the three output files.
8. Print the `git add / commit / push` commands you should run.

## Flags

| Flag | Default | Description |
|---|---|---|
| `--in <file>` | required | Input `.docx`, `.txt`, or `.md` |
| `--id <id>` | required | Chapter id — kebab case (e.g. `ch-2002`). Reused on update. |
| `--title <title>` | required | English chapter title |
| `--length <preset>` | `medium` | `short` (5–7w), `medium` (8–12w), `long` (12–18w) |
| `--model <name>` | `gpt-4o` | Any OpenAI model. Try `gpt-4o-mini` for ~30× cheaper. |
| `--dry-run` | off | Run cleaning + split + stats. No API call, no writes. |
| `--yes` | off | Skip all confirmation prompts (CI-style) |
| `--no-cover` | off | Skip auto-generating an SVG cover |

## Examples

**Dry-run a file** to see how the cleaning + clause split look before paying for an API call:

```bash
node tools/translate --in chapter.docx --id ch-2002 --title "..." --dry-run
```

**Update a chapter** (e.g. you re-translated it). Same `--id` — the tool bumps the version so the app shows an "Update" badge:

```bash
node tools/translate --in chapter2002_v2.docx --id ch-2002 --title "..."
```

**Cheap-mode** for bulk translation:

```bash
node tools/translate --in book/ch3.docx --id ch-3 --title "..." --model gpt-4o-mini
```

## What gets written

```
content/
├── library.json                     ← upserted: entry for <id>
├── chapters/
│   └── <id>.json                    ← created/overwritten
└── covers/
    └── <id>.svg                     ← created/overwritten (unless --no-cover)
```

The chapter JSON matches the schema the PWA expects:

```json
{
  "id": "ch-2002",
  "language": "zh",
  "version": 1,
  "title": { "target": "...", "english": "..." },
  "pairs": [
    { "target": "...", "english": "..." }
  ],
  "meta": { "source": "chapter2002.docx", "createdAt": "2026-05-26", "model": "gpt-4o" }
}
```

## Cost expectations (gpt-4o, late 2025 pricing)

By default the tool runs **translation + word-level alignment**. Alignment powers the reader's color-coded mapping, tap-to-learn popovers, and the intensity toggles. It's ~5× the translation cost on its own but enables most of the learning UX.

| Chapter length | Translation | + Alignment | Total |
|---|---|---|---|
| 500 words | $0.03 | $0.15 | $0.18 |
| 1,500 words | $0.10 | $0.45 | $0.55 |
| 3,000 words | $0.18 | $0.90 | $1.08 |
| 5,000 words | $0.30 | $1.50 | $1.80 |

Pass `--no-alignment` to skip the alignment pass — translation-only, ~5× cheaper, but the new reader features fall back to the plain pinyin/English view for that chapter.

`gpt-4o-mini` is ~30× cheaper at slightly lower phrasing quality.

## After running the tool

Review the generated `chapter.json` (especially proper-noun transliterations and any clauses where the validator complained), then publish:

```bash
git add content/
git commit -m "Add ch-2002"
git push
```

GitHub Pages redeploys in ~30s. On your phone:

1. Open the PWA from your home screen
2. Browse → see the new chapter at the top → **Add**
3. Library → tap the cover → read

## Troubleshooting

**`Missing OPENAI_API_KEY`** — most likely your `.env` file isn't where the tool expects it. It must be at `tools/translate/.env` with a line like `OPENAI_API_KEY=sk-...`. Verify with `cat tools/translate/.env`. If you'd rather use a shell env var, `export OPENAI_API_KEY=sk-...` also works.

**Validation warns "no tone marks detected"** — the model occasionally returns ASCII pinyin for a clause. Re-run the tool — it's usually a one-off. If it persists, the source clause is unusual (e.g. it's already a pinyin name) and you can ignore the warning.

**"Pair count mismatch"** — rare with `gpt-4o`. Re-run, or split the input file into halves and translate each separately.

**Cleaning was too aggressive** — answer `n` at the preview prompt to abort. Open the source `.docx` in Word, strip out the page-number/header structure yourself, save as `.txt`, and re-run on the `.txt`.
