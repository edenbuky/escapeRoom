FROM artifact.it.att.com/docker-public-group/node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
COPY apps/game-engine/package.json ./apps/game-engine/package.json
COPY apps/local-runtime/package.json ./apps/local-runtime/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/messaging/package.json ./packages/messaging/package.json
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
		--mount=type=secret,id=jfrog_access_token,required=false \
		--mount=type=tmpfs,target=/run/npm-config \
		set -eu; \
		if [ -s /run/secrets/jfrog_access_token ]; then \
			printf 'registry=https://artifact.it.att.com/artifactory/api/npm/apm0039582-npm-group/\n//artifact.it.att.com/artifactory/api/npm/:_authToken=%s\n//jfrog-pkg-proxy.it.att.com/artifactory/api/npm/:_authToken=%s\n' \
				"$(cat /run/secrets/jfrog_access_token)" "$(cat /run/secrets/jfrog_access_token)" > /run/npm-config/npmrc; \
			export NPM_CONFIG_USERCONFIG=/run/npm-config/npmrc; \
		elif [ -s /root/.npmrc ]; then \
			export NPM_CONFIG_USERCONFIG=/root/.npmrc; \
		else \
			echo 'Missing npmrc or jfrog_access_token BuildKit secret' >&2; exit 1; \
		fi; \
		npm ci
COPY . .
RUN npm run build:foundation

FROM artifact.it.att.com/docker-public-group/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ARG USER_NAME=tdp
ARG GROUP_NAME=tdp
RUN addgroup -S $GROUP_NAME && adduser -S $USER_NAME -G $GROUP_NAME

COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/package*.json ./
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/apps/game-engine/package.json ./apps/game-engine/package.json
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/apps/game-engine/dist ./apps/game-engine/dist
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/apps/local-runtime/package.json ./apps/local-runtime/package.json
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/packages/messaging/package.json ./packages/messaging/package.json
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/packages/messaging/dist ./packages/messaging/dist
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/src ./src
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/scripts/migrate-shared.js ./scripts/migrate-shared.js
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/scripts/start-deployed.js ./scripts/start-deployed.js
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/sandboxes/sql/fixtures ./sandboxes/sql/fixtures
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/sandboxes/git/fixtures ./sandboxes/git/fixtures
COPY --from=builder --chown=$USER_NAME:$GROUP_NAME /app/scripts/check-deployed-ready.js ./scripts/check-deployed-ready.js
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
		--mount=type=secret,id=jfrog_access_token,required=false \
		--mount=type=tmpfs,target=/run/npm-config \
		set -eu; \
		if [ -s /run/secrets/jfrog_access_token ]; then \
			printf 'registry=https://artifact.it.att.com/artifactory/api/npm/apm0039582-npm-group/\n//artifact.it.att.com/artifactory/api/npm/:_authToken=%s\n//jfrog-pkg-proxy.it.att.com/artifactory/api/npm/:_authToken=%s\n' \
				"$(cat /run/secrets/jfrog_access_token)" "$(cat /run/secrets/jfrog_access_token)" > /run/npm-config/npmrc; \
			export NPM_CONFIG_USERCONFIG=/run/npm-config/npmrc; \
		elif [ -s /root/.npmrc ]; then \
			export NPM_CONFIG_USERCONFIG=/root/.npmrc; \
		else \
			echo 'Missing npmrc or jfrog_access_token BuildKit secret' >&2; exit 1; \
		fi; \
		npm ci --omit=dev

USER $USER_NAME
EXPOSE 3000 3001
ENTRYPOINT ["node", "src/index.js"]
