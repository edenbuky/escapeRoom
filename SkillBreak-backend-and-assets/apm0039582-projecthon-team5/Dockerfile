FROM artifact.it.att.com/docker-public-group/node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY apps/game-engine/package.json ./apps/game-engine/package.json
COPY apps/local-runtime/package.json ./apps/local-runtime/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/messaging/package.json ./packages/messaging/package.json
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci
COPY . .
RUN npm run build --workspace @team5/contracts && npm run build --workspace @team5/messaging && npm run build

FROM artifact.it.att.com/docker-public-group/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ARG USER_NAME=tdp
ARG GROUP_NAME=tdp
RUN addgroup -S $GROUP_NAME && adduser -S $USER_NAME -G $GROUP_NAME

COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/package*.json ./
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/apps/game-engine/package.json ./apps/game-engine/package.json
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/apps/local-runtime/package.json ./apps/local-runtime/package.json
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/packages/messaging/package.json ./packages/messaging/package.json
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/packages/messaging/dist ./packages/messaging/dist
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/src ./src
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci --omit=dev --workspaces=false

USER $USER_NAME
EXPOSE 3000
ENTRYPOINT ["node", "src/index.js"]
