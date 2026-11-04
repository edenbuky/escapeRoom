#!/bin/sh
set -eu
umask 077

options="-c listen_addresses='' -c unix_socket_directories=/run/postgresql -c shared_buffers=16MB -c max_connections=12 -c max_wal_size=8MB -c min_wal_size=2MB -c logging_collector=off -c log_statement=none -c log_min_error_statement=panic -c log_min_messages=panic"
if [ -e "$PGDATA/PG_VERSION" ]; then
  [ "$(cat "$PGDATA/.skillbreak-seed" 2>/dev/null)" = room1-sql-v1 ] || {
    printf '%s\n' 'Existing PostgreSQL data is incomplete; refusing reseed' >&2
    exit 1
  }
else
  mkdir -p "$PGDATA"
  initdb --no-instructions --encoding=UTF8 --locale=C --wal-segsize=1 \
    --auth-local=trust --auth-host=reject --username=sandbox_owner >/dev/null
  pg_ctl -D "$PGDATA" -o "$options" -w start >/dev/null
  psql -h /run/postgresql -U sandbox_owner -d postgres -v ON_ERROR_STOP=1 \
    -c 'CREATE DATABASE puzzle OWNER sandbox_owner' >/dev/null
  psql -h /run/postgresql -U sandbox_owner -d puzzle -v ON_ERROR_STOP=1 \
    -f /opt/sql/fixture.sql >/dev/null
  printf '%s\n' room1-sql-v1 > "$PGDATA/.skillbreak-seed"
  pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null
fi
# All arguments are fixed trusted server settings, never player input.
exec postgres -D "$PGDATA" -c "listen_addresses=" -c unix_socket_directories=/run/postgresql \
  -c shared_buffers=16MB -c max_connections=12 -c max_wal_size=8MB -c min_wal_size=2MB \
  -c logging_collector=off -c log_statement=none -c log_min_error_statement=panic -c log_min_messages=panic
