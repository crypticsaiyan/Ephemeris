<div align="center">

# Ephemeris

**A research agent over NASA's archival video.**

**Live:** [ephemeris-taupe.vercel.app](https://ephemeris-taupe.vercel.app). Every pull request gets its own preview and a TestSprite check before merge; see [Testing](#testing).
Ask a question in plain English. Get a cited answer, ordered by when things actually happened,
plus an auto-edited evidence reel cut from the exact seconds that support it.

[![VideoDB](https://img.shields.io/badge/built%20on-VideoDB-5b4ee9?style=flat-square)](https://videodb.io)
[![Python](https://img.shields.io/badge/python-3.12-3776ab?style=flat-square&logo=python&logoColor=white)](https://www.python.org)
[![Next.js](https://img.shields.io/badge/next.js-15-000000?style=flat-square&logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![Three.js](https://img.shields.io/badge/three.js-r3f-049ef4?style=flat-square&logo=threedotjs&logoColor=white)](https://docs.pmnd.rs/react-three-fiber)
[![Licence](https://img.shields.io/badge/licence-MIT-16a34a?style=flat-square)](LICENSE)

</div>

---

## Why this is not a search box

A search box takes a query and returns clips. Ephemeris takes a **question**, decomposes it,
retrieves across five indexes and two time axes, orders the evidence by the era each moment
discusses, and returns an answer no single clip contains, together with the reel that proves it.
"Show me Mars footage" is retrieval; "trace how our understanding of water on Mars changed over
time" is the query the whole system is built around.

Built for VideoDB's "Unlock the Footage" hackathon. All footage is real NASA public-domain video
pulled live from the [NASA Image and Video Library](https://images-api.nasa.gov). Nothing is
synthetic and no output is mocked.

**Corpus:** 87 clips, 240 minutes, 1,484 scenes, 1957 to 2025. Earth 473 scenes, mars 227, deep
space 199, ground 139, earth orbit 114, sun 107, moon 99, then comets, saturn, jupiter, titan.
Venus and mercury are **zero**, and the agent knows it: see [refusing to answer](#refusing-to-answer).

## How VideoDB is used

| Layer | Surface |
|---|---|
| Ingest | `coll.upload(url=...)` straight from NASA asset URLs |
| Understanding | `video.understand()` with a chained analyzer graph |
| Cross-modal fusion | `vlm` with `inputs=["transcript","ocr"]` and `{{inputs.*}}` in its prompt |
| Structured extraction | `vlm` `config.schema` with enums, so scenes carry typed fields |
| Artifact reuse | one VLM artifact backing **two** indexes with different `use_for` |
| Custom index | `video.index(source=[records])` for NASA metadata VideoDB never saw |
| Retrieval | `semantic_search`, `query`, `aggregate` |
| Field-level search | `index_names=["scene_semantic.scene_description"]` |
| Synthesis | `coll.generate_text(response_type="json")` |
| Word timings | `video.get_transcript()` on v1, deliberately |
| Evidence reels | v2 editor `Timeline` / `Track` / `Clip` / `TextAsset`, `generate_stream()` |
| Sharing | `coll.make_public()` in `ingest.py`, so any key can query the corpus read-only |

Reasoning runs on VideoDB's own LLM, so the project needs exactly one API key.

### The analyzer graph

```
spoken_words ──┐
               ├──> vlm   (inputs · schema · {{inputs.*}})
ocr ───────────┘
```

The VLM describes each scene while reading what was said and printed during it, so fusion happens
at ingestion rather than as a merge of three searches at query time. `ocr` is load-bearing: NASA
footage carries burned-in lower-thirds and mission clocks, and where narration is sparse it is the
only textual signal there is.

### The indexes

| Index | Source | `use_for` | Answers |
|---|---|---|---|
| `transcript` | `spoken_words` | semantic + fts | what was said |
| `scene_semantic` | `vlm` | semantic | what is visible |
| `scene_facets` | **same** `vlm` artifact | query, aggregate | what kind of scene it is |
| `ocr` | `ocr` | semantic, query, aggregate | what is printed on screen |
| `mission_meta` | custom records | query, aggregate, sort | who, where, and when |

One VLM pass, two retrieval surfaces, no extra inference cost.

## Four ways to know a date

NASA's library holds almost nothing published before 2000, so publication date cannot express how
understanding changed across earlier missions: a 2015 explainer routinely discusses a 1976 result.
Every scene carries a date **and a record of how it was known**.

| `era_axis` | Source | Trust |
|---|---|---|
| `scene` | the scene states a year, in speech or on screen | highest |
| `mission` | the year was impossible for the mission, so its operating window decided | corrected |
| `video` | the clip as a whole is anchored to an era | medium |
| `published` | NASA's publication date | always correct, rarely interesting |

A compilation dated once at the top hands that year to every scene beneath it; a Curiosity segment
came back as 1990, twenty-one years before launch. **20.7%** of dated scenes with a known mission
fell outside its window, and **15.7%** of the archive is re-dated. A date the scene stated itself
is never overruled, because archive footage is full of retrospect. Three more provenance axes work
the same way: `body_axis`, `clip_axis` and `mission_axis`.

## Asking a question

```bash
python scripts/ask.py --preset water-mars
python scripts/ask.py "How did the instruments used to look for water on Mars change?"
python scripts/ask.py "..." --json out.json --cap 2 --threshold 0.4 --no-stream
```

Output is the reasoning trace, the cited answer, the evidence in era order, everything discarded
and why, the archive's decade histogram, and one compiled reel.

| Step | What happens |
|---|---|
| decompose | `generate_text` produces sub-questions **and alternate phrasings** |
| gate | is the question answerable at all |
| gate | does the corpus hold the world it names |
| retrieve | each index queried separately, once per phrasing |
| passages | runs of touching cells joined, so the cap chooses between passages |
| era join | every moment joined to its `mission_meta` row, date resolved four ways |
| diversify | two per clip, preferring the world the question named |
| refine | windows snapped to sentence bounds using word-level timings |
| order | sorted by the era each moment discusses |
| aggregate | decade histogram computed server-side |
| synthesize | cited answer plus a chronology, with caveats |
| compile | one reel, era order, provenance burned into the frame |

Choices forced by measurement, not preference:

- **Query expansion is load bearing.** "Twin rovers landing in 2004..." retrieves nothing; the
  archive says "the first of two rovers", and that phrasing hits rank 1 at 0.783.
- **Indexes are queried one at a time.** Scores are not comparable across indexes, and a combined
  call dropped a 0.6899 transcript hit out of 20 results.
- **Diversity is enforced.** Without a per-clip cap the chronology comes from one dense clip.
- **Clips are cut to sentences.** Indexing uses a ten-second grid that cuts speech mid-word; v1
  `get_transcript()` word timings are what land a clip on a boundary.

The trace records every moment dropped with its reason, `below_threshold` with the score or
`per_video_cap` with the cap. Rejects are what make the loop checkable.

### Refusing to answer

Retrieval always returns something, so two gates run first. **Answerability:** given `zxqw
plorbnak fleeming vootrix` the planner once split the gibberish into plausible sub-questions and
answered with confidence; it now reports answerability, and a false ends the run. **Coverage:**
asked how NASA explored Venus, the agent once reasoned from Artemis reentry footage while
conceding no clip showed Venus. There are zero Venus scenes, and the check now ends the run in
**19 seconds** with what the archive does cover.

### The reel

`src/reel.py` uses the **v2 editor** exclusively. Moments are laid out on an integer-second
timeline in era order, each with a `TextAsset` lower-third carrying the citation number, the year,
how that year was determined, the mission and the NASA identifier. Provenance is burned into the
frame, so it survives an export.

## Interface

A navigable solar system. Each retrieved moment stands on the body its scene concerns, rendered as
the hardware the mission actually flew, and the camera moves through the decades as the reel plays.

- **One `activeEvidenceIndex` is the entire sync bus**, shared by inline `[n]` markers, timeline
  needles, shot rows, craft in the scene and the reel's playhead.
- **Beacon colour is the date's provenance**, repeated in words on hover.
- **The era scrubber** spans the years the moments *discuss*, over the archive's decade histogram.
  Undated moments are binned, not dropped.
- **Every question asked is kept**, answered or refused, and reloads from a file read.

## Quality gates

**Retrieval**, `evals/run.py`, against ground truth in `evals/gold.json` built from NASA's own
published `.vtt` captions, so the eval does not grade the pipeline on its own output.

```
35 / 36 cases · mean recall 0.909
```

| kind | n | recall | | kind | n | recall |
|---|---:|---:|---|---|---:|---:|
| spoken_only | 12 | 1.000 | | historical | 8 | 0.812 |
| visual_only | 4 | 1.000 | | cross_modal | 1 | 0.667 |
| filter | 5 | 0.900 | | vocabulary_gap | 1 | 0.500 |

An earlier run recorded 36/36 at 0.941 and does not reproduce: the index is intact and the
expected windows are present, but ANN ranking has drifted. The number above reproduces today.

**Answers**, `evals/answers.py`, grades saved runs without spending an API call. Seven checks,
each from a failure seen in a real run: `cited`, `grounded`, `on_setting`, `snapped`,
`varied_lengths`, `chronology`, and that a refusal explains itself and shows nothing.

```bash
python evals/run.py                        # retrieval gate
python evals/answers.py data/answers       # answer gate
python tests/test_era.py                   # and seven more suites
cd web && npm test                         # scene placement, craft mapping
```

## Testing

Three layers, each catching what the one below cannot.

**Offline unit tests** (`tests/`, run by CI on every push): reel shot mapping, era extraction, passage selection, mission metadata, speech alignment, coverage policy, and the ask service's HTTP front with a stubbed agent. No network, no key.

**Web checks** (`web/scripts/`, run by CI): scene placement for every celestial body, craft mapping, and the browser-side run store.

**TestSprite, on every pull request.** The suite lives in the TestSprite portal and runs in a cloud browser against the pull request's own Vercel preview, so the check on the PR is about that PR's code, not about main. The merge waits for it. What it covers, 18 tests:

| Area | What is asserted |
|---|---|
| Presets | Each Start preset loads an answer, chronology, evidence and reel; switching presets replaces the loaded run and marks the active one |
| Answer and chronology | Citation numbers map to evidence rows; chronology points are in ascending date order |
| Evidence list | Rows render earliest era first; clicking a row changes the active moment and seeks the reel |
| Evidence reel | The player loads the HLS stream, or says that the stream is slow or that the browser cannot decode it, with a link; a bare spinner is a failure |
| Orrery | Clicking a body's name focuses it and opens the body panel with its counts; the sidebar shows the era range and the four provenance kinds |
| Ask form | Empty input keeps submit disabled; a question past 400 characters is refused on the page before any request |
| Saved runs | The Asked list shows its empty state in a fresh browser |
| Live ask | One real question goes through the ask service: running state, progress trace, an answer with chronology and evidence, saved to the browser, survives a reload, reopens without rerunning |

The live-ask test is the only one that spends VideoDB credits, and the visitor quota in `web/lib/ratelimit.ts` bounds it. The first run of this suite found four real gaps, fixed in the same pull request that carried the red check: body names over the orrery were not click targets, an over-limit question was only refused by the server, the Asked list disappeared when empty, and a browser without H.264 support sat on a spinner forever.

## Setup

Python 3.12 and Node 20 or newer. Two processes: the ask service runs the agent, and the web
app serves the page and forwards questions to it.

```bash
uv venv .venv --python 3.12
uv pip install --python .venv -r requirements.txt
cp .env.example .env                       # then add your own VideoDB key
ASK_SERVICE_TOKEN=dev .venv/bin/python -P src/ask_service.py    # http://localhost:8000
```

In a second terminal, give the web app the same token and the service's address, then start it:

```bash
cd web
printf 'ASK_SERVICE_URL=http://localhost:8000\nASK_SERVICE_TOKEN=dev\n' > .env.local
pnpm install && pnpm dev                   # http://localhost:3000
```

The presets on the landing page need neither the service nor a key; only live asks do.

`.env.example` carries the collection id, because the corpus is public and any key can search it.
Measured against a second account, that sharing covers retrieval and nothing else:

| Borrowed with your own key | |
|---|---|
| `semantic_search`, `aggregate`, video metadata | works |
| `generate_text` against the borrowed collection | refused, "not found in your account" |
| `get_transcript` on a borrowed video | refused, "Video not found" |
| `generate_stream` from a borrowed video | refused, "Video info not available" |

Synthesis therefore runs against the caller's own collection, which is what `text_collection()`
in `src/videodb_client.py` returns, while retrieval stays on the shared corpus. Two capabilities
degrade and the run continues without them: clips stay on the indexing grid rather than snapping
to sentence bounds, and no evidence reel is compiled, so `reel.stream_url` comes back empty.

Ingestion and indexing always need a collection you own.

The collection id is never optional. `conn.get_collection()` with no argument returns the account
default, and collection-scoped search then fans out over every indexed video in scope.

Commands below write `python` for the environment just created. `uv venv` does not activate
anything, so either `source .venv/bin/activate` first or call `.venv/bin/python` directly.

## Deploying

Two deployments, because the two halves want different hosts.

**The web app** is a plain Next.js project under `web/`. It runs on a Node host; the live one is on
[Vercel](https://vercel.com) with `web` as the project's root directory, which gives every pull
request a preview URL of its own. The presets are copied into `public/answers` at build time by
`sync-answers.mjs`, so the landing page is complete with no backend at all. Live asks need two
environment variables:

| Variable | Why |
|---|---|
| `ASK_SERVICE_URL` | Where the ask service answers, without a trailing slash. |
| `ASK_SERVICE_TOKEN` | Shared secret the route sends as `x-service-token`. Unset, the route answers 503 and spends nothing. |
| `EPHEMERIS_ASK_TOKEN` | Optional. Set it and send `x-ask-token` to bypass the visitor quota during a live demo or an automated test run. |

**The ask service** is `src/ask_service.py`, the Python agent behind one endpoint, built by the
`Dockerfile`. `render.yaml` targets [Render](https://render.com)'s free instance type, which needs
no card: deploy it with **New → Blueprint**, pointed at `main`. The image is host-agnostic and
reads `PORT`, so [Google Cloud Run](https://cloud.google.com/run) works the same way if a card on
file is acceptable; its always-free allowance covers roughly 1,500 runs a month with no idle
shutdown. The service needs:

| Secret | Why |
|---|---|
| `VIDEO_DB_API_KEY` | Use the key that **owns** the corpus. A borrowed key degrades exactly as the table above describes, and the deployed demo would compile no evidence reels. |
| `VIDEODB_COLLECTION_ID` | Never leave it blank; see the note in Setup about the account default. |
| `ASK_SERVICE_TOKEN` | The same value the web app holds. Unset, the service refuses every ask. |

The browser never reaches the service directly: only the web route holds the token, and the
visitor quota in `web/lib/ratelimit.ts` sits in front of it, five questions an hour and two runs
at once. It is protecting the VideoDB credits, not the box: a public ask endpoint spends real
money on whatever traffic finds it. Do not deploy live asks without it.

A run takes about **two minutes**, which is long enough that a proxy reading silence will hang
up on it. The service writes an SSE comment every fifteen seconds and the route passes the bytes
through untouched, so nothing in between sees a dead connection. The route's `maxDuration` is
300 seconds for the same reason. Sizing, measured rather than assumed: a full run peaks at
**49 MB** of RSS for the agent, so two at once fit a 512 MB free instance with room to spare.

Saved runs live in the visitor's browser, in `localStorage`, and neither server keeps any
history: the agent writes its result to a temp directory, the service streams it out, and the
directory is deleted. The trade is that a run is private to the browser that asked for it and
there is no URL that reopens one for somebody else.

Render's free instance sleeps after fifteen minutes idle and takes about a minute to wake, which
lands on top of the two-minute run for the first live ask after a quiet spell. The landing page
is unaffected, because it never touches the service.

The earlier single-container deployment, with the Next server spawning the agent in one tree, is
kept on the `deploy/free` branch so its link keeps working.

## Pipeline

```bash
python scripts/discover.py          # rank NASA candidates per domain by historical reach
python scripts/select.py            # balance them into a per-domain quota
python scripts/ingest.py --from-selection
python scripts/build.py --workers 6 --vlm-model basic --no-ocr
python scripts/repair_indexes.py --apply   # rebuild anything a schema change dropped
python scripts/dump_era.py          # cache mission_meta rows for the agent join
python scripts/dump_bodies.py       # per-body corpus facts for the interface
python scripts/corpus_report.py     # era coverage, body spread, index health
python scripts/refresh_answers.py --saved  # regenerate shipped answers after a pipeline change
```

An index name is a schema contract across the collection: change the record structure and every
video carrying the old one loses its index, which is what `repair_indexes.py` rebuilds. Presets are
generated output, not source, which is what `refresh_answers.py` keeps current. Every step is
idempotent; understanding ids and index names live in `data/manifest.json`, so a re-run resumes
rather than repeating paid work.

## Reproducing the corpus

Optional. The shipped collection is public and read-only, so querying the archive needs nothing
but your own key. Rebuild it only to own the corpus outright: to re-run ingestion, change the
schema, or index footage this selection left out.

What makes a rebuild faithful is `data/selection.json`, which pins the exact NASA ids, so the same
87 clips are ingested again rather than approximated.

```bash
# 1. A collection of your own, created in the VideoDB console, in .env
#      VIDEO_DB_API_KEY=...
#      VIDEODB_COLLECTION_ID=c-...

# 2. The shipped manifest points at another account's uploads, and ingest skips any clip
#    that already has a video_id. Move it aside or every upload is skipped.
mv data/manifest.json data/manifest.upstream.json

# 3. 19 curated clips plus the 68 in data/selection.json
.venv/bin/python scripts/ingest.py --from-selection

# 4. Understanding and indexes. Dropping --no-ocr indexes OCR on every clip rather than
#    the 24 it covers here, which costs more and retrieves better.
.venv/bin/python scripts/build.py --workers 6 --vlm-model basic

# 5. The caches the agent joins against, then the presets
.venv/bin/python scripts/dump_era.py
.venv/bin/python scripts/dump_bodies.py
.venv/bin/python scripts/refresh_answers.py --saved
```

Budget for it: 240 minutes of video ingested and a VLM pass over roughly 1,500 scenes.

The rebuild will not be identical, and the differences are the honest kind. VLM descriptions are
not deterministic, so `scene_semantic` and `scene_facets` read differently. Shot segmentation
varies on archival footage. Approximate-nearest-neighbour ranking drifts, which is why the
retrieval gate moved from 0.941 to 0.909 on an index that never changed. `generate_text` phrases
each answer afresh. Run `python evals/run.py` to see what recall your own build reaches: the gold
windows come from NASA's caption files, not from this pipeline, so they grade any rebuild fairly.

Nothing above is needed to read the shipped answers. The five presets in `data/answer_*.json` are
real pipeline output, and their reels stream from a public collection, so both work with no key
at all.

## Layout

```
src/     nasa, videodb_client, manifest, schema, understanding, indexing,
         era, mission_meta, speech, agent, reel
web/     Next.js app, react-three-fiber orrery, SSE progress
scripts/ discover, ingest, build, ask, refresh, probes, reporting
evals/   gold.json, run.py retrieval gate, answers.py answer gate
tests/   body, mission, era, coverage, passages, speech, reel
docs/    architecture.svg, field-schema.md, quality-gate.md
```

## Architecture

![Architecture](docs/architecture.svg)

Three bands: build it once, query it per question, show it. Purple is a VideoDB call, green is
this project's own logic, blue is data, grey is a local cache, yellow is the browser, and red is
the path a refused question takes.

## Notes on VideoDB behaviour

Verified against the live API rather than taken from the docs, including where the two
disagree: `object_detection` has no hosted model, VLM schema fields
declared `"required": False` vanish from scene data when omitted, shot segmentation is erratic on
archival footage, numeric fields are not aggregatable by default, there are two Editor APIs, and
`Shot.text` is always `None` (the match lives in `metadata["embedded_text"]`).

## Licence

[MIT](LICENSE). The NASA footage is public domain, from the
[NASA Image and Video Library](https://images.nasa.gov). NASA does not endorse this project.
