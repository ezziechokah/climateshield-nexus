FROM node:24-alpine AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/climate-engine/package.json packages/climate-engine/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api apps/api
COPY packages/contracts packages/contracts
COPY packages/climate-engine packages/climate-engine
RUN pnpm --filter @climateshield/contracts build && pnpm --filter @climateshield/climate-engine build && pnpm --filter @climateshield/api build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /workspace/apps/api/dist apps/api/dist
COPY --from=build --chown=app:app /workspace/apps/api/package.json apps/api/package.json
COPY --from=build --chown=app:app /workspace/apps/api/node_modules apps/api/node_modules
COPY --from=build --chown=app:app /workspace/packages/contracts packages/contracts
COPY --from=build --chown=app:app /workspace/packages/climate-engine packages/climate-engine
USER app
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]