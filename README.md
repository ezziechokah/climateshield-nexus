# ClimateShield Nexus

ClimateShield Nexus is an offline-aware climate intelligence and agricultural decision-support platform for smallholder farmers in Kenya. Its intended channels are a responsive web app/PWA, an Android app, and provider-independent USSD/SMS services sharing one backend and domain model.

The system is decision support, not a guarantee of weather, yield, or agricultural outcomes. Risk methods and recommendations must disclose their evidence, limitations, and uncertainty. Synthetic data, when introduced, will be labeled and kept distinct from observations.

## Current status

**Production-readiness work in progress.** The repository contains a SQLite local-demo and PostgreSQL API adapter, versioned SQL migration, responsive web/PWA, Expo Android client, shared illustrative risk engine, Open-Meteo/NASA POWER adapters, identity/privacy controls, offline outboxes, and local USSD/SMS simulators. PostgreSQL migration and API workflows have been tested against a disposable local PostgreSQL 18 instance. The API still deliberately refuses production startup; this is not a production-ready agricultural service.

The initial pilot crop and region are intentionally not selected in code: selecting them responsibly requires local agricultural and climate expertise rather than an invented assumption.

## Requirements


Use Corepack to run the pinned pnpm version, then start the local API and web app:

```powershell
corepack pnpm install
corepack pnpm dev
```

The API listens on port `4000`; Vite serves the web app on port `5173`. Copy `.env.example` to `.env` first if you need a local evaluation administrator, setting `DEVELOPMENT_ADMIN_EMAIL` and `DEVELOPMENT_ADMIN_PASSWORD`. Farmer registration works without that account. SQLite is the local default. To use local PostgreSQL instead, start Compose with `corepack pnpm db:up`, set `DATABASE_MODE=postgres` and `DATABASE_URL=postgresql://nexus:local-dev-only@localhost:5432/climateshield_nexus`, then apply `corepack pnpm --filter @climateshield/api migrate` before starting. Never use the development password outside the local machine. The API intentionally refuses `NODE_ENV=production` while production session security, identity delivery, provider webhooks, and operational gates remain incomplete.

For Expo, run `corepack pnpm --filter @climateshield/mobile dev`. Physical devices need `EXPO_PUBLIC_API_URL` set to the computer's LAN IP and reachable port, not `localhost`.

## Workspace layout

```text
apps/
  api/                 Express API, local SQLite and provider interfaces
  mobile/              Expo Android application
  web/                 React/Vite PWA
packages/
  climate-engine/      Shared deterministic assessment/recommendation logic
  contracts/           Shared Zod validation schemas
```

## Planned milestones

1. Repository foundation: complete.
2. Local backend, SQLite, authentication, farmer and farm records: implemented; production database/security remain.
3. Web and Expo Android source: implemented; emulator/device execution remains.
4. Open-Meteo adapter and provenance: implemented, live call not verified.
5. Shared illustrative climate/rules engine: implemented and unit tested; expert validation remains.
6. Structured optional AI adapter with deterministic fallback and English/Kiswahili templates: implemented; no provider configured.
7. Browser cached read data and feedback queue; mobile SQLite cache: implemented, offline device journeys remain.
8. Local USSD simulator: implemented; provider/shortcode remains external.
9. SMS command/event simulator and feedback: implemented; live SMS and job queue remain.
10. Partial evaluation, setup/status docs and automated checks: implemented; production hardening/deployment remain.

Milestones will be marked complete only after implementation and checks provide evidence. External services (including SMS, USSD, AI, hosting, and any restricted climate products) may require credentials, paid plans, approvals, or partnerships.

## Configuration

`.env.example` contains local-development placeholders only. Copy it to `.env` when services are implemented; never commit populated credentials. A configured URL or provider name does not mean that integration is operational.

## Validation and deployment

Run checks with `corepack pnpm typecheck`, `corepack pnpm test`, and `corepack pnpm build`. Review [CLIMATESHIELD_SETUP_REQUIRED.md](CLIMATESHIELD_SETUP_REQUIRED.md) for exact live configuration requirements and blockers. Before field use, the climate methods and agricultural guidance require review by qualified Kenyan experts and validation with farmers; automated tests cannot establish scientific validity or impact.

## Production and limitations
## Production and limitations

Production deployment is intentionally blocked in API startup. PostgreSQL migrations, HttpOnly browser sessions/CSRF, Redis rate-limit adapter, SMTP recovery adapter and a generic webhook verifier are implemented, but forward migration verification, live Redis/SMTP/provider integrations, provider-specific callbacks, monitoring, restore rehearsal, Android SDK build, external security review and expert scientific validation remain. Browser authentication is cookie-based; account-partitioned browser offline records remain in localStorage and are not encrypted at rest. Offline operation cannot provide fresh forecasts or guarantee background sync. All risk thresholds are illustrative and unvalidated. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [SECURITY.md](SECURITY.md), and [docs/CLIMATE_VALIDATION.md](docs/CLIMATE_VALIDATION.md).