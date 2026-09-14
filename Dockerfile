FROM node:20-slim

# ffmpeg + ffprobe
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# Каталог для готовых клипов (смонтируй сюда Railway Volume, см. README)
RUN mkdir -p /data
ENV FILES_DIR=/data

EXPOSE 8080
CMD ["node", "server.js"]
