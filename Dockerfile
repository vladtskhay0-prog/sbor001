FROM node:20-slim

# Установка ffmpeg (включает ffprobe)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Зависимости
COPY package*.json ./
RUN npm install --omit=dev

# Исходники
COPY . .

# Railway передаёт порт через $PORT; сервер уже слушает process.env.PORT
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
