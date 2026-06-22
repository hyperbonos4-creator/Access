# Cerebro VisionYX — servidor de consultas (solo sirve; el índice se genera en el host).
FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY lib.mjs server.mjs tools.mjs usage.mjs ui.html ./
ENV BRAIN_HOST=0.0.0.0
EXPOSE 8799
CMD ["node", "server.mjs"]
