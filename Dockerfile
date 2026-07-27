# Ephemeris runs as one process on one box, not a front end plus a separate API.
#
# `web/app/api/ask/route.ts` spawns `<repo>/.venv/bin/python scripts/ask.py`, and `lib/answers.ts`
# resolves the repo root as the parent of the Next.js working directory. Both hold only if the
# Python environment and the Next.js server share a tree, with the server started from `web/`.
# That is what this image arranges, and it is why a Node-only host cannot serve live asks.
#
# Sized from measurement, not guesswork: a full run peaks at 49 MB of RSS for the agent and
# 141 MB for the Next server, so roughly 190 MB at runtime. That fits a 512 MB free instance
# with room to spare. The build is the memory-hungry step, and hosts run it on their builders
# rather than on the instance the service ends up with.
#
# Nothing here names a provider. The server reads PORT, which every container host injects.

FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && npm install -g pnpm@10.20.0 \
 && apt-get purge -y curl \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# Runs as a non-root user. Files copied as root stay readable, but `data/answers` has to be
# writable by this user or every saved run silently falls back to a temp directory.
RUN useradd -m -u 1000 user

WORKDIR /app

# Dependencies before sources, so editing code does not reinstall the world.
COPY requirements.txt ./
RUN python -m venv .venv && .venv/bin/pip install --no-cache-dir -r requirements.txt

COPY web/package.json web/pnpm-lock.yaml web/
RUN cd web && pnpm install --frozen-lockfile

COPY src/ src/
COPY scripts/ scripts/
COPY data/ data/
COPY web/ web/

# `pnpm build` runs `sync-answers.mjs` first, which copies the pipeline's own output into
# `web/public/answers`. That directory is gitignored, so without this step the image builds
# cleanly and then serves a 404 for every preset on the landing page.
RUN cd web && pnpm build

# Created here rather than left to the route handler, so the first run is not the thing that
# discovers the directory is missing.
RUN mkdir -p /app/data/answers && chown -R user:user /app

USER user
ENV HOME=/home/user \
    NODE_ENV=production \
    PORT=3000

# PORT is a default for running the image by hand, not a decision. Render, Cloud Run and every
# other container host inject their own and it wins. `next start` reads it and binds every
# interface by default. EXPOSE is documentation only.
EXPOSE 3000

WORKDIR /app/web
CMD ["pnpm", "start"]
