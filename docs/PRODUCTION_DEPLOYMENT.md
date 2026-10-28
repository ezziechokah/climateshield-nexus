# Production Deployment

**Status: BLOCKED.** The API deliberately refuses `NODE_ENV=production` until secure deployment topology, authenticated provider callbacks, migration/backup operations, and independent security review are complete. Do not remove the guard to deploy this version.

## Required release inputs

- Managed PostgreSQL connection with TLS, least-privilege app/migration roles, backup/PITR, tested restore and retention policy.
- Redis service for cross-instance rate limits.
- Exact HTTPS web origin, API domain, certificates and fixed reverse-proxy topology.
- `TRUST_PROXY_HOPS` matching the actual trusted ingress chain; no wildcard proxy trust.
- SMTP sender, credentials, DNS authentication and verified recovery URL.
- Central secret manager and documented rotation/incident process.
- Real SMS/USSD provider credentials and documented signed callback formats only if communication is being activated.
- Monitoring/error tracking provider and privacy-safe log retention.
- Kenyan privacy/telecommunications legal review and agronomy/meteorology validation for the selected pilot scope.

## Release procedure after blockers close

1. Provision PostgreSQL and Redis; restrict ingress and egress by network policy.
2. Set production secrets through the host secret manager. Never bake them into images or frontend/mobile builds.
3. Run a reviewed, backwards-compatible migration job under the migration role; verify migration version and indexes.
4. Confirm backup completion and restore-test evidence before starting the application.
5. Deploy immutable API and web artifacts with TLS ingress; configure strict CORS and trusted proxy hops.
6. Run `/health`, `/ready`, auth/CSRF smoke tests, ownership checks, rate-limit checks and provider-disabled checks.
7. Enable recovery SMTP only after test mail, sender verification and privacy review.
8. Enable SMS/USSD only after provider signature verification, nonce/replay tests, opt-in, STOP, cost caps, delivery callbacks and approved test handset/shortcode checks.
9. Verify monitoring and alerts for API/database/Redis/provider failures and establish on-call escalation.
10. Record release approval, schema version, artifact digest and rollback/restore plan.

## Rollback and incidents

Application rollback should not roll back schema automatically. Use forward-compatible migrations and restore to a new database when data recovery is required. On credential compromise, rotate session/recovery secrets and provider credentials, revoke sessions, preserve safe audit records, and follow the incident process. No production deployment has been run or authorized.
