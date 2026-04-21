#!/usr/bin/env bash
# Mounted into the Postgres container at /docker-entrypoint-initdb.d/
# so it runs exactly once when the volume is freshly initialised.
# Creates the test database alongside the default `loop` database so
# vitest suites can point at `loop_test` in isolation.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'
  CREATE DATABASE loop_test;
EOSQL
