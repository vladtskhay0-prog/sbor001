FROM node:20-bookworm-slim

# ffmpeg + ffprobe
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

# каталог для отдаваемых файлов
RUN mkdir -p /data/clips
ENV DATA_DIR=/data
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
