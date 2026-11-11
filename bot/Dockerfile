FROM node:26.13.0-alpine

WORKDIR /app
COPY bot/*.mjs bot/
COPY vendor/chess.js vendor/chess.js
COPY vendor/stockfish vendor/stockfish

ENV DATA_DIR=/data NODE_ENV=production
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "bot/server.mjs"]
