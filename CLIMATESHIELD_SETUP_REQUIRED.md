# ClimateShield Nexus setup and activation checklist

This document reflects the code currently in this repository. Do not copy secrets into Git. Local simulation is not live provider operation. Production API startup remains deliberately blocked while secure browser sessions, deployment/recovery delivery, provider webhooks, and operational controls are not complete.

## A. Quick start without paid accounts

Requirements: Node.js `24.14.1` (24.x), Corepack, Git, and internet access for the first dependency install. Local demo uses SQLite and does not require Docker. PostgreSQL integration requires PostgreSQL 18 or Docker. Android Studio/SDK is needed only to run the Android app on an emulator; a physical device can use Expo Go where supported.

1. In PowerShell, from the repository root, copy `.env.example` to `.env` and set `DEVELOPMENT_ADMIN_EMAIL` plus a unique `DEVELOPMENT_ADMIN_PASSWORD` (at least 10 characters).
2. Run `corepack pnpm install`.
3. Keep `DATABASE_MODE=sqlite` for the default local demo. Run `corepack pnpm dev`. The API listens on port 4000; Vite serves the web app on port 5173 and proxies `/api` requests to the API.
4. Open `http://localhost:5173`, register a farmer with an E.164 phone such as `+254700000001`, add a farm and manually set its county/locality, then choose **Demo assessment**. The result uses a labeled synthetic fixture, not current weather.
5. To try the Android client, in another shell run `corepack pnpm --filter @climateshield/mobile dev`. Set `EXPO_PUBLIC_API_URL` to an address reachable from the device. `localhost` on a physical Android device refers to the phone itself; use the development computer's LAN IP and ensure the firewall permits port 4000.
6. To exercise simulated basic-phone registration and SMS, use the web app's USSD/SMS simulator panel. An agreed USSD registration creates a local demo profile/farm. Simulator messages are not transmitted.

To use PostgreSQL locally, start it with `corepack pnpm db:up`, set `DATABASE_MODE=postgres` and `DATABASE_URL=postgresql://nexus:local-dev-only@localhost:5432/climateshield_nexus`, then run `corepack pnpm --filter @climateshield/api migrate` before `corepack pnpm dev`. Do not use the Compose development password in a deployed environment.

No live shortcode, SMS, AI, KMD/ICPAC, mapping, or production hosting integration is configured. Open-Meteo and NASA POWER adapters can make real requests with network access; neither was verified against a live provider during this work.

## B. Prerequisites and compatible runtime versions

| Setting | Purpose | Required value | Placeholder location | Configuration method | How to obtain | Mandatory? | Test | Security | Status |
|---|---|---|---|---|---|---|---|---|---|
| Node.js | API, web, tooling, Node built-in SQLite | `24.14.1` or compatible 24.x | `package.json` `engines` | Install runtime locally/CI | [Node.js downloads](https://nodejs.org/en/download) | Yes | `node --version`; expected 24.x | No secret | Available in development environment; verify in deployment |
| pnpm | Monorepo package installation | `pnpm@12.15.0` | root `package.json` `packageManager` | Corepack | `corepack pnpm --version` | Yes | `corepack pnpm install` | No secret | Verified locally |
| Android tooling | Emulator/device native execution | Android Studio SDK/JDK supported by Expo SDK 58 | `apps/mobile/app.json` | Install Android Studio and SDK locally | [Android Studio](https://developer.android.com/studio) | No for web/API; yes for local emulator | `adb devices`, then `corepack pnpm --filter @climateshield/mobile android` | Signing keys are secrets | Not installed in the current environment |

## C. Database configuration and migrations

| Service or setting | Purpose | Required value | Placeholder location | Configuration method | How to obtain | Mandatory? | Test | Security | Status |
|---|---|---|---|---|---|---|---|---|---|
| Local SQLite database | Local demo persistence | `DATABASE_MODE=sqlite`, `DATABASE_PATH` | `.env.example`; `apps/api/src/db.ts` | `.env` | No account required | Default local mode | `corepack pnpm test`; register and restart | Personal data stays local; protect the DB file | Implemented and tested locally |
| PostgreSQL | Shared production-capable database adapter and persistence | `DATABASE_MODE=postgres`, `DATABASE_URL`, optional `DATABASE_SSL`, `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS` | `.env.example`; pool in `apps/api/src/db.ts`; schema in `apps/api/migrations/001_initial.sql` | `.env` locally; deployment secret manager for hosted environment | Local [PostgreSQL](https://www.postgresql.org/download/) or managed database account | Required for staging/prod; SQLite remains local-only | `corepack pnpm --filter @climateshield/api migrate`, then `DATABASE_MODE=postgres DATABASE_URL=... corepack pnpm --filter @climateshield/api test` | URL/password secret; require TLS for remote DB | Adapter and initial migration implemented; migration + 17 API tests verified against isolated PostgreSQL 18 |

PostgreSQL migration is explicit and versioned; API startup refuses an unmigrated schema. Do not run a migration against production without backup, review, and a maintenance plan. Automated rollback is not provided: write a reviewed forward migration. SQLite local schema upgrades are additive at startup. Backup/restore runbooks are in `docs/DEPLOYMENT.md`; a managed-provider backup test remains a production gate.

## D. Authentication, session, and security configuration

| Setting | Purpose | Required value | Placeholder location | Configuration method | How to obtain | Mandatory? | Test | Security | Status |
|---|---|---|---|---|---|---|---|---|---|
| Farmer account | Authenticate web/mobile access | Name, unique email, E.164 phone, password of 10+ chars, language `en` or `sw` | `packages/contracts/src/index.ts` | Registration UI/API | Farmer supplies own details | Required per farmer | API integration tests cover registration/login | Async scrypt; email/phone are personal data | Implemented locally; email/phone verification remains unimplemented |
| Browser session | Authenticate web without exposing credential to JavaScript | HttpOnly `climateshield-session` cookie locally; `__Host-climateshield-session` + Secure in production; 8-hour lifetime; CSRF header `X-CSRF-Token` | `apps/api/src/index.ts`; browser wrapper `apps/web/src/main.tsx` | API sets cookie; HTTPS required for Secure production cookie | No external account; deploy TLS at host/ingress | Required for browser production | Cookie/CSRF integration tests; production HTTPS smoke test still required | HttpOnly token never enters localStorage; CSRF token is in memory only | Implemented and locally tested; production host topology unverified |
| Native session | Authenticate Android API requests | Opaque bearer credential stored in Expo SecureStore; server stores hash | `apps/mobile/app/index.tsx`, API sessions table | Issued by API | No account beyond farmer | Required for native API | API login/expiry/revocation tests; device check outstanding | Do not log or export token | Implemented; Android device unverified |
| Recovery email | Deliver single-use 15-minute password reset link | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASSWORD`, `RECOVERY_PUBLIC_ORIGIN` | `.env.example`; `apps/api/src/services/recovery-delivery.ts` | Local `.env`; production secret manager | Select an SMTP/email provider; obtain verified sender/domain and credentials from its official dashboard | Optional locally (simulator); mandatory for real recovery | Verify SPF/DKIM/DMARC and send to a controlled mailbox; ensure link uses `#token` fragment | SMTP credentials secret; recovery token must never be logged; use TLS | Abstraction/tests implemented; no SMTP provider configured or live message tested |
| Account recovery token | Reset password once | `POST /auth/recovery/request`, `POST /auth/recovery/complete`; 15-minute hash stored | `apps/api/src/index.ts`, migration `apps/api/migrations/001_initial.sql` | API | Generated automatically | Required for reset | API tests cover generic response, expiry/reuse/session revocation; email delivery is separate | Only local simulator may return token to caller | Local lifecycle verified |
| Development administrator | Access actual-record evaluation summary | `DEVELOPMENT_ADMIN_EMAIL`, `DEVELOPMENT_ADMIN_PASSWORD` | `.env.example`; bootstrap in `apps/api/src/index.ts` | Local `.env`; only bootstrapped while `NODE_ENV` is not `production` | Choose locally; no default credential is shipped | Optional locally; admin view requires it | Restart API, log in, request `/evaluation/summary`; farmer role receives 403 | Keep password private; never commit `.env` | Placeholder implemented; role is not editable through API |
| Production mode | Prevent local simulator/admin bootstrap | `NODE_ENV=production` | `.env.example` | Deployment environment | Set in hosting configuration | Mandatory for production | Start with production env and verify `/simulation/*` returns 404 | Do not use demo simulator routes as production webhooks | Local production guard exists; production auth/database not deployment-ready |

## E. Climate and weather data providers

| Service or setting | Purpose | Required value | Placeholder location | Configuration method | How to obtain | Mandatory? | Test | Security | Status |
|---|---|---|---|---|---|---|---|---|---|
| Open-Meteo forecast | Seven aligned daily precipitation and max-temperature values | `OPEN_METEO_BASE_URL=https://api.open-meteo.com`; no API key | `.env.example`; adapter `apps/api/src/providers/climate.ts` | API `.env`/server config | [Forecast API docs](https://open-meteo.com/en/docs) | Optional; use explicit demo fixture offline | Select forecast on a farm with saved coordinates; inspect `provenance.freshness`; deterministic mocks cover malformed data, retries and stale result | Coordinates are sensitive; do not include in public URL/logs | Adapter and mock tests implemented; live provider not verified |
| NASA POWER | Historical daily point data, never forecast | `NASA_POWER_BASE_URL=https://power.larc.nasa.gov/api/temporal/daily/point` | `.env.example`; adapter `apps/api/src/providers/climate.ts` | API `.env` override if official endpoint changes | [NASA POWER API docs](https://power.larc.nasa.gov/docs/services/api/) | Optional | `GET /farms/:id/climate/historical?start=YYYYMMDD&end=YYYYMMDD`; requires farm coordinates | Follow NASA terms/attribution; historical date range and location are personal-context data | Adapter/mock tested; live response not verified |
| Kenya Meteorological Department | Official forecasts/climate products | Institutional access, approved API or data agreement, provider docs, credentials if issued | No code placeholder yet | Agreement and deployment secrets/config to be designed | [Kenya Meteorological Department](https://meteo.go.ke/) | Optional for application demo; required for any KMD product claim | Obtain approved test endpoint and validate provenance with KMD | Do not scrape or bypass access controls | Awaiting documentation/access; not implemented |
| ICPAC | Regional forecast/outlook | Approved product/API access and usage terms | No code placeholder | Provider-specific config to be designed | [ICPAC](https://www.icpac.net/) | Optional | Test only after product access and attribution review | Respect terms and geographic limitations | Not implemented |

The risk bands currently in `packages/climate-engine/src/index.ts` are explicitly illustrative and not validated. The Open-Meteo daily response is not a farm-scale observation. Dry-spell assessment from that adapter currently returns insufficient data because consecutive dry-day history is not computed.

## F. AI provider configuration

An optional OpenAI-compatible structured explanation adapter exists. It receives assessment/rule records only, validates the response, and falls back to deterministic templates. It is not a validated evidence source and cannot change risk levels.

| Service or setting | Purpose | Required value | Placeholder location | Configuration method | How to obtain | Mandatory? | Test | Security | Status |
|---|---|---|---|---|---|---|---|---|---|
| AI provider | Optional structured-language explanations | `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` | `.env.example`; adapter `apps/api/src/explanations.ts` | Backend-only secret manager | Compatible provider's official registration/docs | Optional; deterministic templates remain | Tests cover no-key and malformed response fallback; verify `explanation.mode` with authorized test account | API key secret, never bundled | Implemented/tested with fixtures; no live provider verified |

## G. SMS gateway setup

No real gateway adapter or outbound job queue exists. The web console/API records simulator events and explicitly reports messages not sent.

| Service or setting | Purpose | Required value | Placeholder location | Configuration method | How to obtain | Mandatory? | Test | Security | Status |
|---|---|---|---|---|---|---|---|---|---|
| SMS gateway | Real outbound/inbound messages and delivery receipts | Provider/account, API key, sender ID, approved sender, callbacks, message-cost agreement | `SMS_PROVIDER`, `SMS_API_KEY`, `SMS_SENDER_ID` in `.env.example` (unused placeholders) | Provider dashboard plus deployment secrets | [Africa's Talking](https://africastalking.com/) is a candidate; confirm current Kenya product, account access, pricing, sender approval and API docs directly | Optional for local demo; required for real SMS | Not possible until adapter/account/callback are implemented; simulator test is available | API key is secret; never expose or commit | Simulator available; live adapter not implemented |
| SMS consent and STOP | Record consent/opt-out | User consent timestamp and command `STOP` | `apps/api/src/index.ts`, `apps/api/src/db.ts` | Simulator endpoint for local | Real provider inbound webhook needed later | Required before sending real alerts | Use simulator HELP/INFO/STOP after login; confirm opt-out record in evaluation store | Phone number is personal data | Local simulator command handling implemented; not a carrier-confirmed opt-out |

## H. USSD gateway, shortcode, carrier, or aggregator provisioning

| Service or setting | Purpose | Required value | Placeholder location | Configuration method | How to obtain | Mandatory? | Test | Security | Status |
|---|---|---|---|---|---|---|---|---|---|
| USSD aggregator/provider | Forward carrier sessions to the API | Provider account, approved callback URL, authentication/signature scheme, session constraints | `USSD_PROVIDER`, `USSD_WEBHOOK_SECRET` in `.env.example` (unused placeholders) | Provider dashboard + production secret manager | Candidate: [Africa's Talking](https://africastalking.com/); request current Kenya USSD docs/pricing/support | Optional locally; mandatory for carrier operation | No real provider callback exists; test local simulator only | Verify signatures, replay protection, rate limits before deployment | Simulator available; provider adapter/webhook authentication not implemented |
| Shortcode/service code | Let farmers dial a provisioned USSD string | Assigned code such as a future `*333#`, short/long code type, network coverage and approved service | `USSD_SERVICE_CODE` in `.env.example` | Provider/carrier provisioning process | Request code allocation from aggregator/operator and obtain written approval | Mandatory for real USSD | Dial only after the provider confirms provisioning and routing | Avoid publishing unprovisioned shortcode as active | Not configured; no code is active |

The local simulator session progresses through language, county, locality, crop, and consent, then writes a local user/farm record. County/locality options are demonstration values and must be replaced with a verified Kenya locality directory before deployment.

## I. GPS, mapping, and geocoding

| Service or setting | Purpose | Required value | Placeholder location | Configuration method | How to obtain | Mandatory? | Test | Security | Status |
|---|---|---|---|---|---|---|---|---|---|
| Browser GPS | Optional coordinates chosen by farmer | Browser geolocation permission; no key | `apps/web/src/main.tsx` | User grants permission on action | Browser/device prompt | No; manual location is supported | Click Use GPS on HTTPS or localhost; deny permission and confirm manual path remains | Avoid logging precise coordinates | Implemented; device test not performed |
| Android GPS | Optional coordinates chosen by farmer | Android foreground location permission | `apps/mobile/app.json`, `apps/mobile/app/index.tsx` | OS permission prompt | User grants permission per app | No | Run on device, allow/deny and verify manual entry | Request only on user action; no continuous tracking | Source implemented; emulator unavailable |
| Maps/geocoding | Map display/locality reverse lookup | No value currently used | None | Future provider integration | No service chosen | No | No test | Location can be sensitive | Not implemented; no map/geocoder call is present |

## J. Push notifications or email

No email, push token, push provider, or email provider is implemented. No credentials are required locally. For future deployment, select a provider, document sender identity, callbacks and delivery testing, and add backend-only credentials after implementation.

## K. Android build and signing requirements

| Setting | Purpose | Required value | Placeholder location | Configuration method | How to obtain | Mandatory? | Test | Security | Status |
|---|---|---|---|---|---|---|---|---|---|
| Android application identifier | Package identity | `org.climateshield.nexus` | `apps/mobile/app.json` | Edit Expo config before store release | Choose unique ID and verify store namespace availability | Local Expo Go: no; production distribution: yes | `corepack pnpm --filter @climateshield/mobile typecheck`; native build requires SDK | Public identifier, not secret | Placeholder in source |
| Expo API URL | Backend address reachable by app | `EXPO_PUBLIC_API_URL` | `.env.example`, read in `apps/mobile/app/index.tsx` | `.env`/Expo public build variable | Use LAN IP for physical device or HTTPS API origin | Yes for device/API use | Check device can load `/health` | Public value only; no secrets allowed with `EXPO_PUBLIC_` prefix | Local value example present |
| Android signing key | Sign distributable application | Private keystore, alias, passwords | No signing file checked in | EAS credentials or secure CI secret store | [Expo EAS Build](https://docs.expo.dev/build/introduction/) or Android signing docs | No for local development; yes to publish | Verify signed artifact and signature before distribution | Highly sensitive; never commit | Not configured; SDK/JDK/emulator absent |

## L. Web hosting, backend deployment, database hosting, and domain

| Setting | Purpose | Required value | Placeholder location | Configuration method | How to obtain | Mandatory? | Test | Security | Status |
|---|---|---|---|---|---|---|---|---|---|
| Web/API origin | Browser CORS allow origin and client API endpoint | `WEB_ORIGIN` and frontend proxy/origin | `.env.example`; `apps/web/vite.config.ts` | Deployment env + reverse proxy | Choose HTTPS domain and configure DNS/TLS at host | Local optional | Verify preflight and API health from deployed origin | Restrict CORS to expected origins | Local Vite proxy implemented; production origin setup not implemented |
| API port | Local HTTP listener | `API_PORT` (default `4000`) | `.env.example`, `apps/api/src/index.ts` | `.env` or deployment port env | Host assigns/accepts port | Local default | `GET /health` | Keep behind HTTPS reverse proxy in production | Implemented |
| Hosting | Run web/API and HTTPS | Provider account, project, region, domain, deploy credentials | No host config yet | Provider dashboard/CI secrets | Select Node 24 compatible host | Required for public launch, not local demo | Deploy smoke tests, TLS and log review | Least-privilege deploy tokens; no secrets in CI logs | Not configured |
| Production database | Shared persistent production data | `DATABASE_MODE=postgres`, `DATABASE_URL`, `DATABASE_SSL=true`, pool limits | `.env.example`; `apps/api/src/db.ts`; SQL `apps/api/migrations/001_initial.sql` | Deployment secret manager | Managed PostgreSQL provider account and connection URL; [PostgreSQL](https://www.postgresql.org/download/) for self-managed | Mandatory for staging/prod; hosting/account may incur cost | Apply migration explicitly; run PostgreSQL-backed API suite; verify `/ready` | Connection URL/password secret; TLS required for remote DB | Adapter/migration implemented and tested against disposable local PostgreSQL 18; managed hosting not configured |

## M. Environment variables and their exact meanings

| Variable | Used by current code? | Meaning/default | File |
|---|---|---|---|
| `NODE_ENV` | Yes | `production` disables simulator routes and local admin bootstrap; any other value is local mode | `apps/api/src/index.ts` |
| `DATABASE_MODE` | Yes | `sqlite` local demo or `postgres`; production rejects SQLite | `apps/api/src/db.ts` |
| `DATABASE_PATH` | Yes | SQLite file path; default `./data/climateshield.sqlite` | `apps/api/src/db.ts` |
| `DATABASE_URL` | Yes for PostgreSQL | PostgreSQL connection URL | `apps/api/src/db.ts` |
| `DATABASE_SSL` | Yes | `true` enables TLS certificate verification for PostgreSQL | `apps/api/src/db.ts` |
| `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS` | Yes | PostgreSQL pool size and connect timeout | `apps/api/src/db.ts` |
| `DB_STATEMENT_TIMEOUT_MS` | Yes | Per-statement PostgreSQL timeout; default 10000 ms | `apps/api/src/db.ts` |
| `REDIS_URL` | Yes when configured; mandatory before production guard can be lifted | Redis-compatible URL for distributed fixed-window rate-limit buckets | `apps/api/src/services/rate-limit.ts` | Server secret/env | Managed Redis account/URL | Optional local; mandatory multi-instance/staging/prod | Local memory unit test; CI service test; production outage should fail limited requests closed | Treat URL/password as secret; restrict network access | Redis adapter implemented; no local Redis binary or live Redis test here |
| `TRUST_PROXY_HOPS` | Yes | Integer 0-5; default 0 disables forwarded-IP trust | `apps/api/src/index.ts` | Deployment env | Determine exact ingress chain with hosting/network operator | Required only behind a trusted reverse proxy | Verify remote address through the actual proxy and spoofed XFF cannot change client identity | Incorrect hop count can enable IP spoofing/cookie mistakes | Implemented; deployment topology unverified |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`, `SMTP_USER`, `SMTP_PASSWORD`, `RECOVERY_PUBLIC_ORIGIN` | Used when SMTP recovery configured | Server SMTP connection/sender and HTTPS web origin | `.env.example`; `apps/api/src/services/recovery-delivery.ts` | Server secret manager | SMTP provider account, sender/domain verification and credentials | Optional local; mandatory for real account recovery | Controlled mailbox delivery and token lifecycle test | Password secret; never expose links/tokens in logs | Simulator and SMTP adapter tests; no real SMTP configured |
| `API_PORT` | Yes | API listen port; default `4000` | `apps/api/src/index.ts` |
| `WEB_ORIGIN` | Yes | CORS allow-origin; default `http://localhost:5173` | `apps/api/src/index.ts` |
| `OPEN_METEO_BASE_URL` | Yes | Open-Meteo-compatible API base URL; default `https://api.open-meteo.com` | `apps/api/src/index.ts` |
| `DEVELOPMENT_ADMIN_EMAIL` | Yes, local only | Optional admin account email | `apps/api/src/index.ts` |
| `DEVELOPMENT_ADMIN_PASSWORD` | Yes, local only | Optional local admin password, scrypt hashed on bootstrap | `apps/api/src/index.ts` |
| `EXPO_PUBLIC_API_URL` | Yes | Mobile app backend URL; defaults to `http://localhost:4000` | `apps/mobile/app/index.tsx` |
| Recovery delivery | Yes if SMTP is configured | SMTP secret/sender and public origin; local-only simulator otherwise | `apps/api/src/services/recovery-delivery.ts` |
| `NASA_POWER_BASE_URL` | Yes | NASA POWER daily point endpoint base URL | `apps/api/src/providers/climate.ts` |
| `SMS_PROVIDER`, `SMS_API_KEY`, `SMS_SENDER_ID` | No | Reserved for unimplemented live SMS adapter | `.env.example` |
| `USSD_PROVIDER`, `USSD_SERVICE_CODE`, `USSD_WEBHOOK_SECRET` | No | Reserved for unimplemented live USSD adapter | `.env.example` |
| `AI_PROVIDER` | No | Informational placeholder; adapter uses OpenAI-compatible base URL/model | `.env.example` |
| `AI_BASE_URL`, `AI_MODEL`, `AI_API_KEY` | Yes, only when all are set | OpenAI-compatible endpoint base, model ID, and server-side secret for optional structured explanation | `apps/api/src/explanations.ts` |

## N. Accounts, callback URLs, and dashboard settings

Currently no third-party callback URL is active. When the relevant adapters are implemented and before live testing, provide provider dashboard access, API permission scopes, webhook signature method/secret, callback URLs under your HTTPS domain, allowed IP/origin settings, sender identity approval, service code and session limits. Do not configure provider callbacks to the local simulator endpoints; production rejects `/simulation/*` and has no authenticated live webhook endpoints yet.

## CI, vulnerability scanning, and secret management

| Service or setting | Purpose | Required value | Placeholder location | Configuration method | Where to obtain | Mandatory? | Testing | Security warning | Status |
|---|---|---|---|---|---|---|---|---|---|
| GitHub Actions | Automated typecheck/tests/build on push and pull request | GitHub repository with Actions enabled; no secret is required for current checks | `.github/workflows/ci.yml` | Repository settings and workflow | GitHub repository owner | Optional for local demo; required for team release gating | Inspect workflow run for Node/pnpm versions and PostgreSQL service health | Restrict workflow permissions/tokens; do not print secrets | Workflow implemented, not executed in this environment |
| Dependency advisory | Dependency patch tracking | `pnpm audit` advisory triage | root `pnpm-workspace.yaml` overrides and `pnpm-lock.yaml` | CI/manual command | pnpm registry advisory feed | Required before production | `corepack pnpm audit --prod`; currently exits nonzero for Expo CLI Zod 3 advisory | Do not suppress advisories without maintainer/vendor confirmation | One unresolved advisory documented |
| Production secret manager | Hold DB/provider credentials | deployment-specific secret names documented above | No hosting provider selected | Host secret store; never `.env` committed to deployment artifacts | Hosting provider account | Mandatory for production | Verify secret injection and rotation without logging values | Restrict access, rotate after staff changes/incidents | Not configured |

## O. Final activation checklist

- [ ] Complete local quick start and review synthetic labels.
- [ ] Choose a pilot crop and geography with local agricultural experts; confirm thresholds and advice before representing guidance as validated.
- [ ] Configure managed PostgreSQL, apply reviewed migration, rehearse backups/restores; implement secure production web sessions, recovery delivery, phone/email verification and access review.
- [ ] Obtain and review privacy notice, consent wording, retention/deletion policy, and Kenyan data protection/telecommunications advice.
- [ ] Verify Open-Meteo/NASA POWER live responses and attribution; obtain approved KMD/ICPAC access if desired.
- [ ] Implement authenticated SMS/USSD provider adapters, webhooks, idempotency, retries, opt-out and delivery receipts; obtain sender/shortcode approvals.
- [ ] Configure production host, HTTPS, domain/DNS, secrets, logs/monitoring, rate limits, and alerts.
- [ ] Set `NODE_ENV=production`; verify local admin bootstrap and all simulation endpoints are unavailable.
- [ ] Build/test Android on supported SDK/device; create protected signing credentials only when release is intended.
- [ ] Conduct farmer usability tests in English/Kiswahili and review Kiswahili with native speakers.
- [ ] Run security, load, privacy, and recovery checks; do not enroll farmers until authorized review is complete.

## P. Live integration test checklist

- [ ] Open-Meteo: use a known test coordinate, confirm HTTP error behavior, timezone, units, attribution, retrieval timestamp and no stale-as-fresh presentation.
- [ ] KMD/ICPAC/NASA POWER: no tests until access and an adapter exist; record sample provenance and allowed use.
- [ ] SMS: send only to an authorized test handset; verify provider message ID, callback signature, actual delivery status, duplicate suppression, HELP and STOP.
- [ ] USSD: provider sandbox/test code first; verify session limits, duplicate requests, expiry, consent, language, locality values, cancellation and carrier behavior.
- [ ] AI: no tests until adapter; validate response schema, prompt-injection resistance, fallback, language and key isolation.
- [ ] Android GPS/offline: test permission grant/denial, cached read behavior, reconnect sync, app restarts, and a physical device with reachable API URL.
- [ ] Production: test least-privilege roles, cross-farmer isolation, deletion, backups/restoration, CORS, HTTPS and secret rotation.

## Q. Troubleshooting

- `pnpm` not recognized: run package commands through `corepack pnpm` as documented.
- Port 4000 occupied: set `API_PORT` and adjust Vite proxy configuration in `apps/web/vite.config.ts`.
- Mobile cannot reach `localhost`: set `EXPO_PUBLIC_API_URL` to the development computer's LAN IP; allow port 4000 through the local firewall.
- Open-Meteo fails: verify internet, valid coordinates in Kenya, endpoint availability and that demo mode is chosen explicitly if offline.
- Farm location rejected: coordinates are bounded to Kenya in `packages/contracts/src/index.ts`; choose manual county/locality if GPS is inaccurate.
- Cannot open evaluation summary: only a local `ADMIN` role can access it; set local development admin variables before first server startup. No self-service elevation endpoint exists.
- Offline feedback remains pending: reconnect to the same API/account; the browser retains it in localStorage. Browser data clearing removes unsynced operations.
- Expo install reports package metadata awaiting approval: this is pnpm package metadata; use pnpm's documented approval workflow after reviewing the dependency. Native run additionally requires Android SDK/JDK.
- SQLite locked/corrupt: stop API before copying the DB and its WAL files; do not use SQLite as a multi-instance production database.

## R. Current capability status

| Feature | Works locally | Simulated | Needs credentials/approval | Current limitations |
|---|---:|---:|---:|---|
| Farmer registration/login and farm ownership | Yes | No | Production identity/security review | Browser uses HttpOnly cookie + CSRF; native uses SecureStore bearer; email/phone verification and production review remain |
| Persistence | Yes | No | Managed PostgreSQL hosting for deployment | SQLite local and PostgreSQL migration path; tested on isolated local PostgreSQL |
| Web dashboard/PWA | Yes | No | Hosting/domain for public use | Account-partitioned browser snapshots/outboxes use localStorage and are not encrypted at rest; browser cookie E2E and offline restart tests remain |
| Android app source | Typecheck and Expo config | No | Android SDK for build; signing for release | Not device-built here; farm outbox persists, native behavior unverified |
| GPS/manual farm locations | Web/API source | Device GPS in app | Browser/device permission | No map or reverse geocoding |
| Open-Meteo forecast / NASA POWER historical | Adapters and deterministic tests | No | Internet and provider terms; no API key currently | Live requests not verified; no KMD/ICPAC adapter |
| Demo climate assessment | Yes | Yes, labeled | None | Illustrative thresholds, not validated; not a forecast |
| Recommendations/localized templates | Yes | Template fallback | Local expert and native-speaker review | English/Kiswahili strings are not field validated; crop/stage/resources not yet modeled deeply |
| AI explanations | Fallback and schema-validated adapter | No | Optional provider account/key | No real provider verified |
| USSD registration | Yes, local registry | Yes | Shortcode, aggregator, carrier approval for real sessions | Locality menu uses demo values; no authenticated provider webhook |
| SMS commands and event records | Yes, simulator | Yes; no network send | Gateway account, key, sender approval, callback | No live send queue, retries or real delivery callbacks |
| Feedback/evaluation summary | Yes, actual local DB records | No fabricated data | Local admin setup | Role-protected summary and CSV export; production operations remain blocked |
| Push/email, maps, satellite and AI | No | No | Provider selection/configuration | Not implemented |

## External reference links

- [Open-Meteo API](https://open-meteo.com/en/docs)
- [Open-Meteo terms](https://open-meteo.com/en/terms)
- [NASA POWER API](https://power.larc.nasa.gov/docs/services/api/)
- [Kenya Meteorological Department](https://meteo.go.ke/)
- [ICPAC](https://www.icpac.net/)
- [Africa's Talking](https://africastalking.com/)
- [Expo Android build](https://docs.expo.dev/build/introduction/)
- [Android Studio](https://developer.android.com/studio)