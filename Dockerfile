FROM node:20-slim

# Install git for sandbox PR workflow
# Update ca-certificates first, then install git and curl for better SSL/TLS support
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     git \
     bash \
     ca-certificates \
     curl \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Configure git to use more robust SSL settings
RUN git config --global http.sslVerify true \
  && git config --global http.postBuffer 524288000 \
  && git config --global http.version HTTP/1.1

RUN useradd -m -u 10001 appuser
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src

# Sandbox workdir
ENV OPENCLAW_WORKDIR=/tmp/penny-jobs
RUN mkdir -p /tmp/penny-jobs && chown -R 10001:10001 /tmp/penny-jobs

# Local brain storage (fast reads, backed up to GCS)
ENV OPENCLAW_BRAIN_DIR=/data/openclaw-brain
RUN mkdir -p /data/openclaw-brain && chown -R 10001:10001 /data/openclaw-brain
VOLUME ["/data/openclaw-brain"]

USER 10001
ENV NODE_ENV=production
ENV CI=1
EXPOSE 8080

CMD ["npm", "start"]
