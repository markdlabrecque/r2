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
USER ${AGENT_UID}:${AGENT_GID}
ENV PATH="/home/agent/.local/bin:$PATH"
WORKDIR /home/agent
ENTRYPOINT ["sleep", "infinity"]
