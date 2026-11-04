FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS helper
WORKDIR /opt/sql
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab
COPY --from=helper /usr/local/bin/node /usr/local/bin/node
COPY --from=helper /opt/sql /opt/sql
COPY query-helper.mjs /opt/sql/query-helper.mjs
COPY fixtures/room1-sql-v1.sql /opt/sql/fixture.sql
COPY entrypoint.sh /opt/sql/entrypoint.sh
RUN chmod 0555 /opt/sql/entrypoint.sh && mkdir -p /run/postgresql && chown 70:70 /run/postgresql
ENV PGDATA=/var/lib/postgresql/data/db NODE_OPTIONS=--max-old-space-size=64
USER 70:70
ENTRYPOINT ["/opt/sql/entrypoint.sh"]
