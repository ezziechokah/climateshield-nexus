# Architecture

## Runtime components

- `apps/web`: React/Vite PWA. Uses `/api` proxy in development, browser storage for selected snapshots and feedback/farm outbox.
- `apps/mobile`: Expo Router/React Native client. Uses SecureStore for the bearer token, Expo SQLite for snapshots/outbox, NetInfo and foreground location permission.
- `apps/api`: Express REST API. Owns identity, authorization, data validation, climate adapters, deterministic assessments, consent, feedback, audit and simulator workflows.
- `packages/contracts`: shared Zod schemas.
- `packages/climate-engine`: deterministic risk banding and recommendation templates.
- `apps/api/migrations`: explicit PostgreSQL SQL migrations.

## Data flow

Web/mobile request -> API authentication and ownership check -> async database adapter -> canonical farm/assessment records. Both DB implementations satisfy `Database` in `apps/api/src/db.ts`: SQLite is for local/demo; PostgreSQL is the shared staging/production-capable path. PostgreSQL schema migration is explicit and versioned; API startup never applies DDL automatically.

Climate providers are independent adapters in `apps/api/src/providers/climate.ts`. Open-Meteo forecast and NASA POWER historical values have distinct provenance. Assessment inputs and rule outputs are stored together with linked climate record, engine version, quality state and limitations. The provider response does not itself constitute a validated agricultural forecast.

SMS/USSD routes remain local simulators. They do not send messages or represent an active shortcode. The production guard blocks deployment until web session security, identity delivery, provider webhooks and operational controls are implemented.

## Persistence boundary

The API uses an async repository interface (`query`, `one`, `execute`, `transaction`) rather than route-level DB drivers. It currently uses positional `?` placeholders translated for PostgreSQL, and a SQLite adapter for local runs. Production DB mode requires `DATABASE_MODE=postgres` and `DATABASE_URL`; local demo defaults to SQLite. Use explicit `pnpm --filter @climateshield/api migrate` before starting against PostgreSQL.

## Security boundaries

All farmer APIs authenticate on the server and scope resources to the session user. Browser authentication uses an HttpOnly SameSite cookie plus server-stored session-bound CSRF token; native clients use bearer tokens in SecureStore. ADMIN-only evaluation endpoints authorize at the API. CORS allows one configured origin. Forwarded IP headers are ignored by default; `TRUST_PROXY_HOPS` must match the actual trusted ingress chain. Redis rate limits are distributed when configured and fail closed on Redis failure. A generic HMAC/timestamp/nonce verifier exists but is not connected to a carrier. Production guard remains until staging verification, TLS/proxy configuration, Redis, SMTP recovery, provider-specific callbacks and restore/security review pass.
