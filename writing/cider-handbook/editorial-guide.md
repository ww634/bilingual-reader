# French, tone and app editorial guide

## Voice

Write French first. Use contemporary, idiomatic French: warm, precise and lightly playful. Address the reader consistently as « vous »; inclusive « on » is welcome. Avoid the ceremonial register of an old agricultural treatise and the breathlessness of promotional copy.

Use present tense for explanations and imperatives or « vous pouvez » for appropriate actions. Use explicit conditions where an action is not universally suitable. Completed anecdotes generally use passé composé with imparfait for background. No artificial restriction on natural grammar.

Aim for mostly short-to-medium sentences with varied rhythm. One main conceptual burden per sentence is a useful editing principle, not a word-count law. Keep the referent clear: repeating « le jus » can be kinder than leaving the reader to decode several instances of « il ».

Introduce a technical term with its ordinary meaning and immediate purpose. Reuse the same term before offering synonyms. Explain one distinction at a time; do not stack a string of unfamiliar nouns inside a joke.

## Humour and sensory detail

Use occasional comparisons, understated asides and recognisable workshop inconveniences. No joke quota. Avoid jokes in critical procedural conditions or numerical instructions. Do not mock beginners or portray intoxication as the purpose of the craft.

A metaphor should illuminate one relationship and then give way to a literal explanation. Avoid attributing intention to yeast without clarifying what actually happens. Repeatedly calling fermentation “magic” would undermine the book's educational promise.

Describe where and how a sensation appears: aroma before a sip, mouth-watering acidity, drying texture, a lingering impression. Do not turn every paragraph into a tasting note. Orchard chapters can attend to bark, blossom, light and the weight of fruit; equipment chapters can attend to texture, sound and practical effort.

Example of tone, not chapter text:

« Votre carnet n'a pas besoin d'être élégant. Une date, une mesure et une observation précise lui donneront déjà plus d'utilité qu'une très belle page restée blanche. »

## Language learning through the content

The book must work as French prose with English hidden. English provides support, not missing explanations. Explain specialist vocabulary in French at first meaningful use and reinforce it later through another task.

Use useful recurring constructions: comparing, giving reasons, stating conditions, describing change, acknowledging uncertainty. Do not append grammar lectures, vocabulary dumps or exercises by default.

Introduce a small manageable cluster of new technical terms per passage. If a paragraph requires constant lookup, revise its pacing or move a distinction later. B1–B2 does not mean replacing precise terminology with misleading everyday approximations.

Avoid unexplained regional slang and opaque cultural allusions. A verified fun fact should illuminate the craft; omit trivia inserted only to decorate a chapter.

## Translation and vocabulary

Translate meaning into natural English while preserving quantities, conditions, uncertainty and tone exactly. French « peut » must not become English “will”. Do not add operational advice only in the English translation.

Keep each bilingual pair semantically complete at an appropriate sentence or clause boundary. A source-schema note mentions 3–12-word clauses, but the existing French pipeline also handles whole sentences: meaning and readability determine the split. Never separate a negation, numerical value from its unit, or a condition from the action it governs merely to meet a word target.

Translation alignment and tappable vocabulary have different purposes. Keep ordinary articles, subjects, nouns and modifiers independently accessible in word lookups; retain genuine technical compounds and compact compound verbs where appropriate. Do not bundle an entire action and its object into one vocabulary item.

Select the contextual English sense rather than alternatives separated by slashes. For example, orchard « une taille » concerns pruning, not clothing size. For technical compounds, verify the English industry term rather than translating each component mechanically.

Use French decimal commas in French and English decimal points in English when needed. Check values and units separately so punctuation localisation cannot change a quantity.

## Supported reader format

Verified locally on 20 October 2026 against:

- `content/SCHEMA.md` for book/chapter/pair structure, noting that parts of its language description predate French support.
- `tools/translate/build-markup-book.js` for French markup, chapter headings and paragraph boundaries.
- `content/books/la-derniere-voix-claire/_src/vocabulary/README.md` for separate contextual word lookups.
- `app/js/reader.js` for lookup rendering and `paragraph_start` support.

Use chapter titles and ordinary paragraphs, French/English pairs, translation alignments and reviewed word lookups. Authoring documents may use Markdown headings and lists; those are planning aids, not promises of reader rendering.

The earlier ideas « Le geste utile », « Le piège classique », « Pour les curieux » and « Au nez et en bouche » become editorial prompts woven into prose, not recurring boxes or visual modules. No required table, diagram, sidebar, illustration, chart, formula layout or printable worksheet.

Explain a process sequentially in short paragraphs using « d'abord », « ensuite » and explicit conditions. Explain measurements and arithmetic in words with small inline examples. Keep source citations in the editorial research file unless a later decision establishes an app-compatible reader bibliography.
