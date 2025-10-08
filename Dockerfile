# Dockerfile — use Debian Bookworm so Python >= 3.10 is available
FROM node:20-bookworm

# Install system deps (python3 + ffmpeg + curl)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 \
      ffmpeg \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

# Download yt-dlp standalone executable and make executable
# (We fetch the "latest" release binary)
RUN curl -L -o /usr/local/bin/yt-dlp \
      "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" \
  && chmod +x /usr/local/bin/yt-dlp \
  && /usr/local/bin/yt-dlp --version

# Create app dir
WORKDIR /usr/src/app

# Copy package files and install node deps
COPY package*.json ./
RUN npm ci --only=production

# Copy app source
COPY . .

EXPOSE 3001
ENV PORT=3001

CMD ["node", "server.js"]
