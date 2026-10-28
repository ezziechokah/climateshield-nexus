# Data Privacy

This document describes current implementation behavior, not a legal compliance determination. Obtain Kenyan data protection and telecommunications advice before collecting real farmer data.

## Data categories and purpose

- Account: name, email, phone, language and scrypt password hash for authentication and communication preferences.
- Farm: name, county/locality, optional farm coordinates, crop, planting date and irrigation context for location-relevant decision support.
- Climate/assessment: provider, retrieval/valid times, coordinates, units, provenance, quality, inputs, ruleset version and recommendations for explainable history.
- Consent/preferences: SMS opt-in timestamp and opt-out state. New accounts default to opted out.
- Feedback: assessment link, understanding/usefulness/action indicators and optional comment for service evaluation.
- Security/operations: hashed session/recovery tokens, expiration, and audit actions. Audit metadata is designed to avoid credentials and unnecessary personal data.

## Access and storage

Farmer API routes scope farms, assessments, feedback and preferences by authenticated user ID. Administrators can query aggregate counts, feedback fields and non-identifying audit action metadata. The personal export endpoint provides the authenticated user's account, farms, assessments, feedback and notification preferences. The account deletion endpoint requires the current password and literal confirmation `DELETE`, then cascades owned records; audit actor references are set null in PostgreSQL.

Browser authentication uses an HttpOnly cookie; the synchronizer token is held in memory and is not placed in Web Storage. Browser localStorage contains account-ID-partitioned farm/assessment snapshots and pending mutation records. Android uses SecureStore for bearer token/profile and SQLite for account-owned snapshots/outbox operations. Account switching clears device cache; sign-out clears cache and requires confirmation before discarding pending changes. Device data is not remotely erased by API account deletion. These local stores are not encrypted at rest by the browser and require a shared-device policy before a pilot.

## Consent and messaging

SMS consent is explicit and opt-in. The app does not currently send real SMS. STOP simulation changes the local preference only; it is not a carrier-confirmed opt-out. Do not send notifications until a real gateway adapter, consent policy, callback verification, retry/idempotency and delivery status have been implemented and reviewed.

## Retention and deletion

No automatic retention schedule, legal hold process, backup deletion policy, device wipe mechanism or verified deletion SLA exists yet. Account deletion removes primary account-owned rows from the live database; backups may retain prior encrypted copies until their configured retention expires. Define a retention schedule with counsel and implement/test it before real enrollment.

## Farmer rights and disclosure

Before a real pilot, publish a reviewed privacy notice in English and Kiswahili, explain approximate locality versus precise coordinates, explain data uses and messaging costs, provide access/export/deletion contacts, document processors/transfers, and obtain consent where required. Do not continuously track location; GPS is requested only after a user action.
