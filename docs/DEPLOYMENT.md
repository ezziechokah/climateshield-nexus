# Deployment and Operations

## Current release gate

The API throws at startup when `NODE_ENV=production`. Keep this guard. HttpOnly cookie/CSRF, SMTP recovery abstraction, Redis distributed rate limiting, bounded trusted-proxy hops and generic raw-body HMAC/replay primitives exist, but production is blocked pending live Redis/SMTP verification, provider-specific callbacks, migration/backup operations, monitoring and independent security review.

## Local PostgreSQL

The repo includes `compose.yaml` for a loopback-only PostgreSQL 18 development instance. It uses a clearly development-only password and must never be exposed publicly.

```powershell
corepack pnpm db:up
```

Set `DATABASE_MODE=postgres`, `DATABASE_URL=postgresql://nexus:local-dev-only@localhost:5432/climateshield_nexus`, and optionally `REDIS_URL=redis://localhost:6379`, then apply the initial migration:

```powershell
corepack pnpm --filter @climateshield/api migrate
corepack pnpm dev
```

Stop local services with `corepack pnpm db:down`. The Compose named volume remains unless explicitly removed; avoid destructive volume operations when data matters.

## Migration operation

1. Back up the target database and verify the backup can be restored to an isolated instance.
2. Review migration SQL and expected lock/runtime impact.
3. Run the explicit migrator with staging `DATABASE_MODE=postgres` and secret `DATABASE_URL`; configure `DB_STATEMENT_TIMEOUT_MS` as appropriate.
4. Check `schema_migrations`, API `/ready`, application smoke tests, and logs.
5. For rollback, restore the verified backup or apply a reviewed forward migration. There is no automatic destructive rollback.

The current migration runner discovers ordered SQL migrations and serializes application with a PostgreSQL advisory lock. Migration 001 creates the base schema; migration 002 upgrades existing sessions with CSRF storage and ensures webhook nonce storage. PostgreSQL pool statement timeout defaults to 10 seconds.

## Container

`apps/api/Dockerfile` is a multi-stage build. It is not yet a production image: the production refusal intentionally stops it until the release gates are implemented. The current Dockerfile and workflow need a complete container-build check when Docker is available.

## Backup and restore

For managed PostgreSQL, enable provider-managed encrypted backups and point-in-time recovery. Store backup credentials separately with least privilege. Quarterly, restore a backup to an isolated database, run migration/version checks and API read tests, measure recovery time, and record the result. No production backup provider is configured.

For local SQLite, stop the API before copying the database and associated WAL files. SQLite is not a multi-instance deployment database.

## Staging checklist

- Provision isolated PostgreSQL with TLS and least-privilege app/migration roles.
- Configure server-only environment variables; never expose keys via `EXPO_PUBLIC_`.
- Apply reviewed migration and verify backups/restore.
- Configure HTTPS, exact CORS origin and fixed proxy topology; set `TRUST_PROXY_HOPS` to the exact trusted ingress count (0 by default; never trust arbitrary forwarded headers).
- Configure Redis `REDIS_URL`; verify `/ready` reports the limiter/database dependencies and test Redis outage returns 503 for limited operations.
- Configure SMTP `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASSWORD`, and `RECOVERY_PUBLIC_ORIGIN`; verify recovery mail in a test mailbox and ensure tokens are never logged.
- Configure monitoring, privacy-safe logs, error alerts, resource limits and incident contact.
- Verify farmer isolation, deletion, recovery delivery, consent/STOP and stale provider behavior.
- Keep real messaging disabled until callback authentication, consent, idempotency, cost controls and test handset verification pass.
- Keep provider webhooks disabled until the selected provider's exact signature format is implemented over raw request bytes with timestamp/nonce replay protection.

## Production release checklist

Production release is not currently authorized by code readiness. Before lifting the startup guard, require independent security review, privacy/legal review, validated climate thresholds/guidance, fully verified PostgreSQL-backed workflows, secure web/mobile session lifecycle, provider webhook signature/replay protection, Android signed build validation, restore rehearsal, CI security gates, monitoring/alerts, operational runbooks and a documented rollback plan.
