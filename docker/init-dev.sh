#!/bin/sh
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres -c 'CREATE DATABASE registry;'
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname registry -f /registry-schema.sql
