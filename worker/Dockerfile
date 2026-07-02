# Bleeep Railway worker.
# Railway service root directory must be set to /worker so this Dockerfile is used.
FROM node:20-slim

# System dependencies the pipeline shells out to:
#   ffmpeg   — audio render (fluent-ffmpeg finds it on PATH, no ffmpeg-static)
#   python3  — yt-dlp runtime
#   yt-dlp   — SoundCloud download/convert (installed via pip per spec)
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg \
       python3 \
       python3-pip \
       ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install node deps first so this layer is cached across source-only changes.
COPY package.json package-lock.json* ./
RUN npm install

# Build the TypeScript worker → dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
# Railway injects $PORT; the health server binds to it (defaults to 8080 locally).
EXPOSE 8080
CMD ["node", "dist/index.js"]
