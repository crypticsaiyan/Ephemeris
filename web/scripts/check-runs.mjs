/** Runs kept in the browser.
 *
 *  The browser holds the only copy of a run, so eviction is the part worth guarding: a
 *  store that throws on a full quota loses the run someone just waited ninety seconds for, and a
 *  store that clears itself to make room loses every earlier one instead. Neither failure is
 *  visible in the interface, which shows a list either way.
 *
 *  Run with:  npm test
 */
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const out = mkdtempSync(join(root, ".tmp-runs-"));

function compile() {
  writeFileSync(
    join(out, "tsconfig.json"),
    JSON.stringify({
      extends: "../tsconfig.json",
      compilerOptions: {
        noEmit: false, outDir: ".", module: "esnext", target: "es2020",
        skipLibCheck: true, rootDir: "..",
      },
      include: ["../lib/localRuns.ts", "../lib/types.ts"],
    }),
  );
  execFileSync("npx", ["tsc", "-p", join(out, "tsconfig.json")], { cwd: root, stdio: "inherit" });
}

/** localStorage with a byte budget, which is the only part of it that matters here. Browsers
 *  differ on the limit and on the error's name; they agree that a write past it throws. */
function fakeStorage(budget = Infinity) {
  const map = new Map();
  const used = () => [...map].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    get length() { return map.size; },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    setItem(k, v) {
      const previous = map.get(k) ?? "";
      map.set(k, String(v));
      if (used() > budget) {
        if (previous) map.set(k, previous); else map.delete(k);
        const error = new Error("quota exceeded");
        error.name = "QuotaExceededError";
        throw error;
      }
    },
    _bytes: used,
  };
}

/** A run of roughly the size the pipeline actually produces: measured at 35-47 KB on disk. */
function run(question, filler = 2000) {
  return {
    question,
    answer: { answer: `an answer about ${question}`, citations: [1], chronology: [], caveats: "" },
    evidence: Array.from({ length: 8 }, (_, i) => ({ nasa_id: `clip-${i}`, text: "x".repeat(filler) })),
    reel: { shots: [{ at: 0 }, { at: 12 }] },
    trace: [],
    rejected: { counts: { below_threshold: 0, diversity: 0 } },
    timeline: [],
  };
}

/** Distinct, increasing timestamps, so ordering is tested rather than assumed from insertion. */
function fakeClock() {
  const Real = Date;
  let tick = Real.parse("2026-08-08T00:00:00Z");
  class Fake extends Real {
    constructor(...args) {
      if (args.length === 0) {
        super(tick);
        tick += 1000;
      } else {
        super(...args);
      }
    }
  }
  Fake.now = () => tick;
  globalThis.Date = Fake;
  return () => void (globalThis.Date = Real);
}

async function main() {
  compile();
  const { failedRun, listRuns, loadRun, localRunId, saveRun } = await import(
    pathToFileURL(join(out, "lib/localRuns.js")).href
  );

  const restoreClock = fakeClock();
  const use = (store) => void (globalThis.window = { localStorage: store });

  // A run goes in and comes back out, and the list describes it the way the server's list would.
  use(fakeStorage());
  assert.equal(saveRun("run-a", run("water on mars")), true);
  assert.deepEqual(loadRun("run-a").question, "water on mars");
  const [row] = listRuns();
  assert.equal(row.id, "run-a");
  assert.equal(row.question, "water on mars");
  assert.equal(row.moments, 8);
  assert.equal(row.shots, 2);
  assert.equal(row.answered, true);
  console.log("OK  round trip: a saved run reloads, and the row describes it");

  // The server's id is reused on the client, so a run saved twice is one run, not two rows.
  saveRun("run-a", run("water on mars, again"));
  assert.equal(listRuns().length, 1);
  assert.equal(loadRun("run-a").question, "water on mars, again");
  console.log("OK  one row per id: re-saving replaces rather than duplicates");

  // Newest first, which is the order eviction depends on as well as the order the list shows.
  use(fakeStorage());
  for (const q of ["first", "second", "third"]) saveRun(q, run(q));
  assert.deepEqual(listRuns().map((r) => r.id), ["third", "second", "first"]);
  console.log("OK  newest first");

  // The cap trims without waiting to be told the store is full.
  use(fakeStorage());
  for (let i = 0; i < 55; i += 1) saveRun(`run-${String(i).padStart(2, "0")}`, run(`q${i}`, 10));
  const capped = listRuns();
  assert.equal(capped.length, 50);
  assert.equal(capped[0].id, "run-54");
  assert.equal(capped.at(-1).id, "run-05");
  assert.equal(loadRun("run-00"), null, "an evicted run must not leave its payload behind");
  console.log(`OK  cap: 55 saved, ${capped.length} kept, oldest dropped payload and all`);

  // A full store evicts the oldest until the new run fits. Budget holds about four of these.
  const tight = fakeStorage(100_000);
  use(tight);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(saveRun(`big-${i}`, run(`q${i}`, 2400)), true, `big-${i} should have been kept`);
  }
  const survivors = listRuns();
  assert.ok(survivors.length >= 2 && survivors.length < 10, `kept ${survivors.length} of 10`);
  assert.equal(survivors[0].id, "big-9", "the newest run is the one that must survive");
  assert.ok(loadRun("big-9"), "the newest run's payload must be readable");
  assert.equal(loadRun("big-0"), null, "the oldest must be gone, payload and row together");
  assert.equal(survivors.length, survivors.filter((r) => loadRun(r.id)).length,
               "every listed run must still have its payload");
  console.log(`OK  quota: evicts oldest to fit, ${survivors.length} of 10 survived a 100 KB budget`);

  // A run too big for an empty store is refused, and leaves nothing half-written behind.
  const cramped = fakeStorage(5_000);
  use(cramped);
  assert.equal(saveRun("huge", run("q", 50_000)), false);
  assert.equal(listRuns().length, 0);
  assert.equal(loadRun("huge"), null);
  assert.equal(cramped.getItem("ephemeris.run.huge"), null, "no orphaned payload");
  console.log("OK  refuses a run too big to fit, without orphaning a key");

  // Storage that throws on use, which is Safari in private mode, and no window at all, which is
  // the server render. Neither may throw: the answer is on screen regardless of where it is kept.
  use({ setItem() { throw new Error("denied"); }, getItem() { throw new Error("denied"); },
        removeItem() {}, });
  assert.equal(saveRun("x", run("q")), false);
  assert.deepEqual(listRuns(), []);
  assert.equal(loadRun("x"), null);
  delete globalThis.window;
  assert.equal(saveRun("x", run("q")), false);
  assert.deepEqual(listRuns(), []);
  assert.equal(loadRun("x"), null);
  console.log("OK  storage denied and no window: degrades quietly, never throws");

  // A run that broke still has to leave its question behind. The server used to write this
  // record; there is nowhere on it that could keep one now, so this is the only copy there is.
  use(fakeStorage());
  const broken = failedRun("what broke", "AuthenticationError: Error: Invalid API key");
  assert.equal(broken.failed, true);
  assert.equal(broken.answer.answer, "");
  assert.match(broken.answer.caveats, /did not complete: AuthenticationError/);
  saveRun("broken", broken);
  const [brokenRow] = listRuns();
  assert.equal(brokenRow.failed, true);
  assert.equal(brokenRow.answered, false);
  assert.equal(brokenRow.question, "what broke");
  assert.equal(loadRun("broken").answer.caveats, broken.answer.caveats);
  console.log("OK  a failed run keeps its question and reads as failed");

  // Ids sort as strings and are shown to the user, so the shape has to stay time-ordered.
  assert.match(localRunId("Where else did NASA look for water?"),
               /^\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}-where-else-did-nasa-look-for-water$/);
  assert.match(localRunId("?!?"), /^\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}$/);
  console.log("OK  ids are time-ordered and legible");

  restoreClock();
}

try {
  await main();
  console.log("\nall run-storage checks passed");
} finally {
  rmSync(out, { recursive: true, force: true });
}
