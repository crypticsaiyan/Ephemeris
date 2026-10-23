# The ask service: the Python agent behind one HTTP endpoint.
#
# The web app lives on a Node host of its own and reaches this over `ASK_SERVICE_URL`. This image
# holds only what the agent needs: Python, its dependencies, the pipeline sources and the data the
# retrieval step reads. No Node, no build step.
#
# A full run peaks at 49 MB of RSS for the agent, measured, so two at once fit a 512 MB free
# instance with room to spare. The run spends most of its two minutes waiting on VideoDB.
#
# Nothing here names a provider. The server reads PORT, which every container host injects.

FROM python:3.12-slim-bookworm

# Runs as a non-root user. Files copied as root stay readable, which is all the agent needs: it
# writes only to a temp directory of its own making.
RUN useradd -m -u 1000 user

WORKDIR /app

# Dependencies before sources, so editing code does not reinstall the world.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ src/
COPY scripts/ scripts/
COPY data/ data/

RUN chown -R user:user /app

USER user
ENV HOME=/home/user \
    PYTHONUNBUFFERED=1 \
    PORT=8000

# PORT is a default for running the image by hand, not a decision. EXPOSE is documentation only.
EXPOSE 8000

# `-P` keeps `scripts/select.py` from shadowing the stdlib `select` the server needs.
CMD ["python", "-P", "src/ask_service.py"]
