FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git curl jq python3 make g++ openssl \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
    @earendil-works/pi-coding-agent@1.5.2 \
    @anthropic-ai/claude-code@2.1.322 \
    playwright@1.65.0

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN playwright install --with-deps chromium \
    && chmod -R a+rX /opt/ms-playwright \
    && ln -s "$(find /opt/ms-playwright -type f -path '*/chrome-linux64/chrome' | head -n 1)" /usr/local/bin/chromium \
    && rm -rf /var/lib/apt/lists/*

ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g "$AGENT_GID" node \
    && usermod -o -u "$AGENT_UID" -g "$AGENT_GID" -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}
WORKDIR /home/agent

# Includes b3dfb24: image-bearing tool results in replay and resume prompts.
RUN git init /home/agent/.pi/agent/extensions/pi-claude-subscription \
    && cd /home/agent/.pi/agent/extensions/pi-claude-subscription \
    && git remote add origin https://github.com/markdlabrecque/pi-claude-subscription.git \
    && git fetch --depth 1 origin 05be412cb37cf3b5f5436ed88694c2a84f69bdb6 \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "05be412cb37cf3b5f5436ed88694c2a84f69bdb6" \
    && git rev-parse HEAD > .factory-revision \
    && npm ci --omit=dev --ignore-scripts \
    && rm -rf .git

ENTRYPOINT ["sleep", "infinity"]
