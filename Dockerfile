# Ephemeris runs as one process on one box, not as a front end plus an API.
#
# `web/app/api/ask/route.ts` spawns `<repo>/.venv/bin/python scripts/ask.py`, and `lib/answers.ts`
# resolves the repo root as the parent of the Next.js working directory. Both hold only if the
# Python environment and the Next.js server live in the same tree, with the server started from
# `web/`. That is what this image arranges, and it is why a Node-only host cannot run live asks.

FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g pnpm@10 \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /usr/local/bin/uv

WORKDIR /app

# The agent's dependencies are pinned in one place, the README's setup step, so they are repeated
# here rather than read from a requirements file that does not exist.
COPY scripts/ scripts/
COPY src/ src/
RUN uv venv .venv --python 3.12 \
 && uv pip install --python .venv "videodb>=0.5.1" python-dotenv requests

# Dependencies before sources, so a code change does not reinstall node_modules.
COPY web/package.json web/pnpm-lock.yaml web/
RUN cd web && pnpm install --frozen-lockfile

COPY data/ data/
COPY web/ web/

# `pnpm sync` is not redundant with the `prebuild` hook. pnpm does not run pre/post scripts by
# default, and `web/public/answers` is gitignored, so without this the image builds cleanly and
# then serves a 404 for every preset on the landing page.
RUN cd web && pnpm sync && pnpm build

# The saved-runs directory is a mounted disk in production. Creating it here keeps a diskless
# run (a quick smoke test, a preview service) from falling back to a temp directory silently.
RUN mkdir -p /app/data/answers

ENV NODE_ENV=production
WORKDIR /app/web

# Render injects PORT; `next start` reads it. EXPOSE is documentation only.
EXPOSE 3000
CMD ["pnpm", "start"]
