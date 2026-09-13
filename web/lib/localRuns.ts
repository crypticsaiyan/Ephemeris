/** Saved runs, which the visitor's browser is now the only place to find.
 *
 *  The server used to write every run to `data/answers` and list it back. That copy was never
 *  durable on the deploy this branch targets: a free instance cannot mount a disk, so it died
 *  with the container on every idle restart. Keeping both a copy that vanishes and a copy that
 *  does not meant two histories to reconcile for no gain, so the server's is gone: it writes the
 *  agent's output to a temp directory, streams it out, and deletes it.
 *
 *  What that costs is sharing. A run is private to the browser that asked for it, there is no URL
 *  that reopens one for somebody else, and clearing site data clears the history. What it buys is
 *  that a run belongs to whoever waited the ninety seconds for it, and outlives the box.
 *
 *  Client-only. Every entry point returns an empty result rather than throwing when there is no
 *  `window`, so a server render and a browser with storage disabled behave the same.
 */

import type { AskResult, SavedAnswer } from "./types";

const INDEX_KEY = "ephemeris.runs";
const RUN_PREFIX = "ephemeris.run.";

/** Runs kept before the oldest is dropped. Measured against the corpus: a full answer with its
 *  trace, evidence and reel serialises to 35-47 KB, and the usual localStorage budget is 5 MB per
 *  origin. Fifty is a comfortable fraction of that, and leaves room for whatever else the origin
 *  stores. Eviction below is driven by the quota error rather than by this number alone, because
 *  the budget is a guess about the browser and the error is the browser answering. */
const MAX_RUNS = 50;

/** A stored run's metadata is what the list needs; the answer itself is read only when opened.
 *  Keeping them apart means rendering the list parses a few KB rather than every answer ever
 *  saved. */
type IndexRow = SavedAnswer;

/** The id a run is stored and sorted under. Timestamp first so that string order is time order,
 *  which is what the list and the eviction both rely on, with the question slugged after it so an
 *  id is legible on its own. */
export function localRunId(question: string, now = new Date()): string {
  const stamp = now.toISOString().slice(0, 19).toLowerCase().replace(/[:.]/g, "-");
  const slug = question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug ? `${stamp}-${slug}` : stamp;
}

function storage(): Storage | null {
  try {
    // Access, not just presence: Safari in private mode has `localStorage` and throws on use.
    const store = window.localStorage;
    const probe = `${RUN_PREFIX}probe`;
    store.setItem(probe, "1");
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

function readIndex(store: Storage): IndexRow[] {
  try {
    const parsed = JSON.parse(store.getItem(INDEX_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as IndexRow[]) : [];
  } catch {
    // A corrupt index costs the list, not the answers; it is rebuilt from the next save.
    return [];
  }
}

function writeIndex(store: Storage, rows: IndexRow[]): void {
  store.setItem(INDEX_KEY, JSON.stringify(rows));
}

/** Newest first. The sort is here rather than at the call site because eviction depends on it:
 *  the run dropped to make room is the last one in this order. */
export function listRuns(): IndexRow[] {
  const store = storage();
  if (!store) return [];
  return readIndex(store).sort((a, b) => b.saved.localeCompare(a.saved));
}

export function loadRun(id: string): AskResult | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(RUN_PREFIX + id);
    return raw ? (JSON.parse(raw) as AskResult) : null;
  } catch {
    return null;
  }
}

/** A run that died before it produced an answer, shaped like one that did.
 *
 *  The question is the part worth keeping: losing what was typed is exactly the moment someone
 *  most wants it back, and the agent crashing is not their doing. The server used to write this
 *  stub itself, which is no longer anywhere it could keep it, so the shape lives here now. The
 *  empty answer and the explaining caveat are how a refusal already reads, which is why the rest
 *  of the interface needs no case for it. */
export function failedRun(question: string, detail: string): AskResult {
  return {
    question,
    plan: { sub_questions: [], phrasings: [], visual_phrasings: [],
            needs_chronology: false, rationale: "the run did not complete" },
    answer: { answer: "", citations: [], chronology: [],
              caveats: `This run did not complete: ${detail.slice(-400)}` },
    evidence: [],
    rejected: { below_threshold: [], diversity: [],
                counts: { below_threshold: 0, diversity: 0 } },
    timeline: [],
    trace: [],
    failed: true,
  };
}

function forget(store: Storage, id: string, rows: IndexRow[]): IndexRow[] {
  store.removeItem(RUN_PREFIX + id);
  return rows.filter((row) => row.id !== id);
}

/** Metadata the list shows. Derived from the run itself rather than stored beside it, so a row
 *  can never disagree with the answer it opens. */
function describe(id: string, result: AskResult): IndexRow {
  return {
    id,
    question: result.question ?? id,
    saved: new Date().toISOString(),
    moments: result.evidence?.length ?? 0,
    shots: result.reel?.shots?.length ?? 0,
    answered: Boolean(result.answer?.answer),
    failed: Boolean(result.failed),
  };
}

/** Keeps a finished run, evicting the oldest until it fits.
 *
 *  Returns whether it was kept, which the caller has to act on rather than assume: there is no
 *  copy anywhere else, so a false means this run is gone the moment the page is left. */
export function saveRun(id: string, result: AskResult): boolean {
  const store = storage();
  if (!store) return false;

  let rows = [describe(id, result), ...readIndex(store).filter((row) => row.id !== id)]
    .sort((a, b) => b.saved.localeCompare(a.saved));

  // Trim to the cap before writing, so the common case never has to fail first.
  for (const stale of rows.slice(MAX_RUNS)) rows = forget(store, stale.id, rows);

  const payload = JSON.stringify(result);

  // A quota error is the browser telling us its real budget, which no constant here can know.
  // Drop the oldest run and try again; give up when this run is the only one left and still
  // does not fit, rather than emptying the store for something too big to keep.
  for (;;) {
    try {
      store.setItem(RUN_PREFIX + id, payload);
      writeIndex(store, rows);
      return true;
    } catch {
      const oldest = rows[rows.length - 1];
      if (!oldest || oldest.id === id) {
        rows = forget(store, id, rows);
        writeIndex(store, rows);
        return false;
      }
      rows = forget(store, oldest.id, rows);
    }
  }
}
