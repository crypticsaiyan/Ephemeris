/** Saved runs kept in the visitor's own browser.
 *
 *  `data/answers` is the server's copy and it is not durable on the deploy this branch targets: a
 *  free instance cannot mount a disk, so every saved run dies with the container, which restarts
 *  on idle. The preset answers survive because they are baked into the image; a question someone
 *  actually asked does not. Ninety seconds of retrieval and synthesis, gone on the next cold start.
 *
 *  So the browser keeps its own copy. The server still writes its file and still lists it, and
 *  when it has one it wins: it is the same JSON and it is shared with everyone. This is the
 *  fallback that makes a run outlive the box it ran on, for the person who paid the ninety
 *  seconds for it.
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

/** A stored run's metadata is what the list needs; the answer itself is fetched only when opened.
 *  Keeping them apart means rendering the list parses a few KB rather than every answer ever
 *  saved. */
type IndexRow = SavedAnswer & { local: true };

/** An id for a run the server could not save, so there is no server id to reuse. Deliberately the
 *  same shape as `answerId` in `answers.ts`: these ids are shown as filenames and sorted as
 *  strings, and one that read differently would look like a different kind of thing. */
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

/** The two histories as one list, newest first.
 *
 *  The server's row wins on a shared id. It is the same run, and its copy is the one every other
 *  visitor can open too, so preferring it keeps a click meaning the same thing for everyone. A
 *  local row only fills a gap, which on a diskless instance is most of them after a restart.
 *
 *  `total` counts the union rather than the server's files: it drives the "show all" affordance,
 *  and a count that ignored the browser's runs would offer to reveal runs that are already on
 *  screen while hiding ones that are not. */
export function mergeRuns(
  server: SavedAnswer[],
  local: SavedAnswer[],
  serverTotal = server.length,
): { rows: SavedAnswer[]; total: number } {
  const onServer = new Set(server.map((row) => row.id));
  const extra = local.filter((row) => !onServer.has(row.id));
  return {
    rows: [...server, ...extra].sort((a, b) => b.saved.localeCompare(a.saved)),
    total: serverTotal + extra.length,
  };
}

function forget(store: Storage, id: string, rows: IndexRow[]): IndexRow[] {
  store.removeItem(RUN_PREFIX + id);
  return rows.filter((row) => row.id !== id);
}

/** Metadata the list shows, derived here so a local row and a server row read identically.
 *  Mirrors `listAnswers` in `answers.ts`; the two must agree or the same run would describe
 *  itself differently depending on which copy answered. */
function describe(id: string, result: AskResult): IndexRow {
  return {
    id,
    question: result.question ?? id,
    saved: new Date().toISOString(),
    moments: result.evidence?.length ?? 0,
    shots: result.reel?.shots?.length ?? 0,
    answered: Boolean(result.answer?.answer),
    failed: Boolean(result.failed),
    local: true,
  };
}

/** Keeps a finished run, evicting the oldest until it fits.
 *
 *  Returns whether it was kept. A false is not worth surfacing: the answer is on screen either
 *  way and the server may well have its own copy. It exists so a caller can tell the difference
 *  without catching. */
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
