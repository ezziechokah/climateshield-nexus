# Testing Strategy

## Commands

```powershell
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm audit --prod
```

PostgreSQL integration (requires a disposable PostgreSQL database and valid URL):

```powershell
$env:DATABASE_MODE='postgres'
$env:DATABASE_URL='postgresql://test-user:test-password@localhost:5432/test-database'
$env:TEST_DATABASE_URL=$env:DATABASE_URL
corepack pnpm --filter @climateshield/api migrate
corepack pnpm --filter @climateshield/api test
```

CI provides PostgreSQL and Redis service containers. To exercise the Redis integration locally, provide `TEST_REDIS_URL=redis://localhost:6379`; the corresponding test is explicitly skipped when the variable is absent. API rate-limit middleware tests still verify fail-closed behavior without a server.

The API test suite uses randomized synthetic identities and selects isolated SQLite by default. It uses PostgreSQL only when `TEST_DATABASE_URL` is explicitly supplied. It does not truncate or reset tables. Use a fresh disposable database when validating the initial migration.

## Current coverage

- Climate engine: threshold boundaries, missing/stale/poor data, implausible values, recommendation gating and reproducibility.
- Provider adapters: deterministic Open-Meteo response parsing, invalid coordinates/schema, retry limit, stale-cache status and NASA POWER historical normalization.
- API: registration/session/expiry, cookie flags/CSRF/origin/session replay, farm validation/ownership/update/idempotency (including concurrent retry), assessment provenance, feedback idempotency, USSD/SMS simulation and invalid menus, consent, account export/deletion, recovery and admin denial.
- Services: SMTP delivery interface/simulator, Redis/memory limiter configuration/fail-closed behavior, HMAC webhook timestamp/signature/nonce/replay tests.
- Web: access screen registration/sign-in rendering.
- Mobile: TypeScript validation and Expo config resolution; no native UI test suite yet.

## External/integration boundaries

Provider tests use deterministic fixtures; no live Open-Meteo, NASA POWER, AI, SMS, USSD or carrier request has been verified. PostgreSQL migration and API suite have been run locally against an isolated PostgreSQL 18 test cluster. Do not treat mock-provider tests as proof of provider access or scientific validity.

## Remaining test work

Add Playwright critical browser E2E and service-worker/offline assertions, web outbox tests, Android component/outbox tests, live-provider controlled smoke tests when authorized, session expiry/abuse tests, migration upgrade tests, concurrency tests for idempotent retries, dependency scanner triage, container build, and Android SDK/emulator/device build when tooling is available.
