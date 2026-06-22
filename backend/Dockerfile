# Office Access Control — backend NestJS.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
# Usuario no-root.
RUN useradd --create-home --uid 10001 nodeapp && chown -R nodeapp /app
USER nodeapp
EXPOSE 3000
CMD ["node", "dist/main.js"]
