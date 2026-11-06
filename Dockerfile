# EightyTwenty — Dockerfile
FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
# SQLite data lives in /app/data; Render persistent disk mounts here (see render.yaml).
RUN mkdir -p /app/data
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
