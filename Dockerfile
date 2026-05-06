FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    python3 \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sf /usr/local/bin/node /usr/bin/node

COPY package.json package-lock.json requirements.txt ./

RUN npm ci \
  && python3 -m venv /opt/gmail-venv \
  && /opt/gmail-venv/bin/pip install --no-cache-dir -r requirements.txt

COPY tsconfig.json ./
COPY src ./src
COPY docs ./docs
COPY data ./data

ENV NODE_ENV=production
ENV GMAIL_MCP_PYTHON=/opt/gmail-venv/bin/python
ENV GMAIL_MCP_SERVER_SCRIPT=/root/.cursor/scripts/gmail_mcp_stdio_server.py
ENV TELEGRAM_NODE=/usr/local/bin/node
ENV TELEGRAM_MCP_SCRIPT=/root/.cursor/telegram-mcp-cursor.js
ENV TELEGRAM_MCP_BINARY=/root/.cursor/bin/telegram-mcp

CMD ["npm", "run", "start"]
