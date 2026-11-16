# Project environment only; Factory workflow and tracker access stay on the host.
FROM node:24.20.0-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl jq python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @earendil-works/pi-coding-agent@1.5.2

# Match the project's locked browser version; share it with the non-root agent.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npm install -g playwright@1.65.0 \
    && playwright install --with-deps chromium \
    && chmod -R a+rX /opt/ms-playwright \
    && rm -rf /var/lib/apt/lists/*

ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g "$AGENT_GID" node \
    && usermod -o -u "$AGENT_UID" -g "$AGENT_GID" -d /home/agent -m -l agent node
# Project-owned snapshot, discoverable by Pi without host skill mounts.
COPY --chown=${AGENT_UID}:${AGENT_GID} skills/writing-tests/ /home/agent/.agents/skills/writing-tests/
USER ${AGENT_UID}:${AGENT_GID}
# The bundled Pi discovers its user skills here; retain one copy of the content.
RUN mkdir -p /home/agent/.pi/agent/skills \
    && ln -s /home/agent/.agents/skills/writing-tests /home/agent/.pi/agent/skills/writing-tests
ENV PATH="/home/agent/.local/bin:$PATH"
# Synthetic fixtures avoid slow container-layer fsync; evidence stays on disk.
ENV TMPDIR=/dev/shm
# Native npm builds use the matching headers already shipped in this Node image.
ENV npm_package_config_node_gyp_nodedir=/usr/local
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
