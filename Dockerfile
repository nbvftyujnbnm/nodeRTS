# --- build stage -------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies first so they cache independently of source changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json vite.config.ts ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree we are going to copy forward.
RUN npm prune --omit=dev

# --- runtime stage -----------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json

EXPOSE 8080
USER node

# The server binds 0.0.0.0 and serves dist/client as static files.
CMD ["node", "dist/node/server/index.js"]
