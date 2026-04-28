#!/usr/bin/env bash
# Postgres + pgvector setup for the Tangent EC2.
#
# Run this ONCE on the EC2 hosting Tangent. It:
#   1. Installs Postgres 15 + pgvector
#   2. Configures Postgres to accept connections from the VPC
#   3. Creates two roles for Tangent's tools:
#        - tangent_admin    (CREATEROLE, CREATEDB) — for create_user / drop_user
#        - tangent_query    (read-only)            — for db_query
#   4. Generates random passwords for both, prints them at the end so Daanish
#      can put them in /home/ubuntu/tangent/.env
#   5. Enables the pgvector extension on the default postgres database
#
# Usage:
#   sudo bash scripts/setup-postgres.sh

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: must run as root (use sudo)" >&2
  exit 1
fi

# ─── 1. Install ──────────────────────────────────────────────────────────────
# Ubuntu's default repos don't ship Postgres 15, so add the PostgreSQL APT
# (PGDG) repository first.  Idempotent — safe to re-run.
echo "→ Adding PostgreSQL APT repository (PGDG)..."
apt-get install -y -qq curl ca-certificates lsb-release gnupg

install -d /usr/share/postgresql-common/pgdg
if [[ ! -f /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc ]]; then
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
fi

CODENAME=$(lsb_release -cs)
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" \
  >/etc/apt/sources.list.d/pgdg.list

echo "→ Installing Postgres 15 + pgvector..."
apt-get update -qq
apt-get install -y -qq postgresql-15 postgresql-contrib-15 postgresql-15-pgvector openssl

# ─── 2. Configure listen address + pg_hba ────────────────────────────────────
PG_CONF=/etc/postgresql/15/main/postgresql.conf
PG_HBA=/etc/postgresql/15/main/pg_hba.conf

# VPC CIDR — assumes 10.40.0.0/16 (matches the internal IP 10.40.40.123).
# Override by passing VPC_CIDR=10.x.0.0/16 as an env var.
VPC_CIDR="${VPC_CIDR:-10.40.0.0/16}"

echo "→ Setting listen_addresses = '*' in $PG_CONF"
sed -i "s/^#\?listen_addresses = .*/listen_addresses = '*'/" "$PG_CONF"

if ! grep -q "tangent-vpc-rule" "$PG_HBA"; then
  echo "→ Adding VPC rule to $PG_HBA"
  cat >>"$PG_HBA" <<EOF

# tangent-vpc-rule — allow ECS services in the VPC to reach Postgres
host    all    all    ${VPC_CIDR}    md5
EOF
fi

systemctl restart postgresql

# ─── 3. Create roles + database ──────────────────────────────────────────────
ADMIN_PW=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)
QUERY_PW=$(openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | head -c 32)

echo "→ Creating roles tangent_admin, tangent_query..."
sudo -u postgres psql <<EOF
-- tangent_admin: can create roles and databases, but is NOT a superuser.
-- This is enough for Tangent's create_user / drop_user / create_db tools.
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tangent_admin') THEN
    CREATE ROLE tangent_admin WITH LOGIN CREATEROLE CREATEDB PASSWORD '${ADMIN_PW}';
  ELSE
    ALTER ROLE tangent_admin WITH LOGIN CREATEROLE CREATEDB PASSWORD '${ADMIN_PW}';
  END IF;
END \$\$;

-- tangent_query: read-only across the cluster. Used for db_query.
-- We grant SELECT on every existing table + a default privilege so future
-- tables inherit it automatically.
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tangent_query') THEN
    CREATE ROLE tangent_query WITH LOGIN PASSWORD '${QUERY_PW}';
  ELSE
    ALTER ROLE tangent_query WITH LOGIN PASSWORD '${QUERY_PW}';
  END IF;
END \$\$;

GRANT CONNECT ON DATABASE postgres TO tangent_query;
GRANT USAGE ON SCHEMA public TO tangent_query;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO tangent_query;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO tangent_query;

CREATE EXTENSION IF NOT EXISTS vector;
EOF

# ─── 4. Print the connection strings ─────────────────────────────────────────
HOST_INTERNAL_IP=$(hostname -I | awk '{print $1}')

cat <<EOF

═════════════════════════════════════════════════════════════════════════════
Postgres setup complete.

Add these two lines to /home/ubuntu/tangent/.env (then pm2 restart tangent):

TANGENT_DB_ADMIN_URL=postgresql://tangent_admin:${ADMIN_PW}@127.0.0.1:5432/postgres
TANGENT_DB_QUERY_URL=postgresql://tangent_query:${QUERY_PW}@127.0.0.1:5432/postgres

For deployed ECS services that need Postgres access, use the EC2's internal
IP (${HOST_INTERNAL_IP}) and a per-service role created via:
  @Tangent create db user <name> for service <repo>

The service's connection string lands in Secrets Manager as
  tangent/db/<name>
which can then be injected into the service via:
  @Tangent inject tangent/db/<name> into <repo>

Make sure the EC2's security group allows inbound TCP 5432 from the ECS
service security group (or VPC CIDR ${VPC_CIDR}).
═════════════════════════════════════════════════════════════════════════════
EOF
