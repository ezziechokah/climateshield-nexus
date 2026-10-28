# Staging Deployment

Staging is not yet runnable from this repository end to end; the API keeps its production guard until deployment security and operational gates are satisfied. Use this sequence as the controlled staging target.

## Required services

- Managed PostgreSQL with TLS, backup/PITR, private network access and a migration role separate from the application role.
- Redis-compatible managed service for distributed rate limits (`REDIS_URL`).
- Node.js 24 API host with HTTPS ingress and explicit trusted proxy hop count.
- Static web/PWA host on the configured exact `WEB_ORIGIN`.
- SMTP service with verified sender for password recovery.
- Monitoring/error tracking account selected and configured (not implemented/integrated yet).

## Deployment sequence

1. Provision staging PostgreSQL and Redis in the same region/network as the API.
2. Create an application DB role with only required table CRUD permissions and a separate migration role with DDL permissions.
3. Set secret values: `NODE_ENV=staging` until production start rules are lifted, `DATABASE_MODE=postgres`, `DATABASE_URL`, `DATABASE_SSL=true`, `REDIS_URL`, `WEB_ORIGIN`, `TRUST_PROXY_HOPS`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASSWORD`, and `RECOVERY_PUBLIC_ORIGIN`.
4. Review the migration SQL. Back up the empty/new staging database, then execute `corepack pnpm --filter @climateshield/api migrate` from the API workspace or deployment job.
5. Verify the migration version, expected tables/indexes/foreign keys, `GET /health`, and `GET /ready`.
6. Build web and API artifacts using CI. Do not copy `.env` into images.
7. Configure TLS at ingress; use a fixed proxy-hop topology and set `TRUST_PROXY_HOPS` to the exact number of trusted hops. Do not accept client-controlled forwarded headers from the public edge.
8. Confirm rate-limit failure behavior, cookie `Secure`/`HttpOnly`/`SameSite`, CSRF rejection, recovery email delivery, session revocation and account deletion.
9. Run PostgreSQL integration suite against a disposable staging test DB; never point tests at persistent staging user records.
10. Restore a backup to a separate database and run API readiness/read tests; record restore duration.
11. Attach monitoring and alerting. Provider health should report “not checked” unless an actual provider probe was made.

## Rollback

No automatic down migrations. For a failed application release, roll back the application artifact while preserving the database. For schema rollback, restore a verified pre-migration backup to a new database or apply a reviewed forward migration. Do not reset/drop the existing DB from application startup.

## Current limitations

The API production guard is still active; middleware and deployment dependencies exist but staging deployment has not been run. Browser-cookie rollout, trusted proxy validation, webhook integration, monitoring, restore rehearsal, CI workflow execution and Android build remain verification gates.
