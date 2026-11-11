FROM node:26.13.0-alpine

WORKDIR /app
COPY vendor/chess.js /app/vendor/chess.js
COPY vendor/stockfish /app/vendor/stockfish
COPY bot/server.mjs bot/engine.mjs /app/bot/
RUN mkdir -p /data && chown node:node /data

USER node
ENV DATA_DIR=/data PORT=3000 NODE_ENV=production
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "bot/server.mjs"]
