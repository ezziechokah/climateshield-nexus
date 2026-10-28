# Security Policy

## Reporting a vulnerability

Do not file public issues containing exploit details, credentials, farmer data, or network traces. Until a private security contact is configured, report findings to the repository owner through a private channel and include affected version, reproduction conditions, and impact. Remove personal data and secrets from evidence.

## Current security posture

The API uses async scrypt password hashes, hashed opaque eight-hour sessions, HttpOnly SameSite browser cookies with session-bound CSRF checks, bearer sessions for native clients, one-time hashed recovery tokens, SMTP delivery abstraction, owner-scoped queries, server-side roles, request schemas, payload limits, security headers, origin checks, endpoint-class Redis rate limits with a local memory fallback, audit records, and explicit SMS opt-in. PostgreSQL startup requires an explicitly applied migration. Production startup remains intentionally blocked.

The web no longer stores authentication tokens in localStorage. Browser authentication uses an HttpOnly cookie and a CSRF token held in memory. Redis is required for distributed production rate limiting; local development uses in-memory limits. Trusted proxy headers are ignored unless a bounded `TRUST_PROXY_HOPS` is configured. SMTP recovery and a generic raw-body HMAC/nonce verifier exist, but no production SMTP has been tested and no provider-specific webhook is connected. Email/phone verification, monitoring, independent threat modeling/penetration testing, and deployment verification remain release gates. Do not deploy or enroll real farmers yet.

## Development rules

- Never put credentials, private keys, live farmer data, or production dumps in Git.
- Keep `.env`, databases, signing artifacts, and logs ignored.
- Use synthetic test identities only.
- Use `corepack pnpm audit --prod` and review advisories on dependency changes. Do not suppress advisories merely to make CI green.
- Review authorization and audit behavior when adding routes. Tests should include both allowed and denied cross-farmer access.
- Provider keys and database credentials belong only in server-side secret stores.
- Simulator endpoints are local-only and must not be used as provider webhooks.

For data-handling practices and unresolved obligations see `docs/DATA_PRIVACY.md` and `CLIMATESHIELD_SETUP_REQUIRED.md`.
