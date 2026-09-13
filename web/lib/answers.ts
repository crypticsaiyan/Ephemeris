import { resolve } from "node:path";

/** Where the repo sits, as seen from the Next.js server started in `web/`.
 *
 *  The ask route spawns `<repo>/.venv/bin/python` and runs it with the repo as its working
 *  directory, so this is the one path the server has to resolve for itself.
 *
 *  There used to be more here: a `data/answers` directory, an id generator, a validated path for
 *  reading one back, and a listing. Saved runs live in the visitor's browser now (`localRuns.ts`),
 *  so the server keeps no history at all and none of that has a caller.
 *
 *  Server-only: imported by route handlers, never by a client component. */
export const ROOT = resolve(process.cwd(), "..");
