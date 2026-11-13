# RalpMail

**Open-source, self-hosted email API for transactional email, opt-in bulk campaigns, and email OTPs.**

[Website](https://ralpberry-labs.github.io/ralpmail/) · [Quickstart](#run-locally) · [API reference](#api) · [Deliverability guide](docs/deliverability.md)

[![Tests](https://github.com/Ralpberry-Labs/ralpmail/actions/workflows/test.yml/badge.svg)](https://github.com/Ralpberry-Labs/ralpmail/actions/workflows/test.yml)

RalpMail is an MIT-licensed project from Ralpberry Labs. Queue application email, verify email addresses with one-time codes, trigger scheduled follow-ups, and run newsletters for subscribers who opted in. Bring a verified sending domain and your own SMTP relay. RalpMail adds no per-email fee. Relays, servers, storage, and operating the service may have costs.

This first release is a single-organization API for trusted backend callers. It uses Node.js 22+, PostgreSQL 17+, and SMTP with mandatory TLS. See the [deliverability research and rollout guide](docs/deliverability.md) for sender requirements, what to measure, and what to verify before scaling.

## Run locally

```sh
git clone https://github.com/Ralpberry-Labs/ralpmail.git
cd ralpmail
npm ci
docker compose up -d db
cp .env.example .env
openssl rand -hex 32
openssl rand -hex 32
```

Put the generated values in `API_KEY` and `OTP_SECRET`. Set a different random `FEEDBACK_KEY` if ingesting relay events. Configure at least one lane with its verified From address and SMTP URL. Use `smtps://user:password@relay.example.com:465` or `smtp://user:password@relay.example.com:587` with STARTTLS. URL-encode special characters in credentials. Enable marketing with a separate sender and an HTTPS `PUBLIC_ORIGIN` that reaches the API's unsubscribe routes.

```sh
node --env-file=.env src/migrate.js
node --env-file=.env src/server.js
# In a second terminal
node --env-file=.env src/worker.js
```

```sh
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/emails \
  -H "Authorization: Bearer ${RALPMAIL_API_KEY}" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: receipt-1001' \
  -d '{"to":"customer@example.com","subject":"Your receipt","text":"Thank you for your purchase."}'
```

Set `RALPMAIL_API_KEY` in your shell to the value configured as `API_KEY`. Replace the recipient with an address you control before running a live test. To test locally without sending external email, run `npm test`. The integration suite starts a disposable PostgreSQL database and local SMTP capture server.

## API

Send JSON with `Authorization: Bearer <API_KEY>`. The feedback endpoint uses its own key. Health and unsubscribe routes are public. Each enqueue endpoint requires a unique `Idempotency-Key` of up to 128 visible ASCII characters. Reuse a key and the same payload when retrying a request. Enqueue responses use HTTP 202 and return queued IDs.

| Method and path | Body or purpose |
| --- | --- |
| `POST /emails` | `{to, subject, text, scheduledAt?}`. Transactional email to one address. |
| `POST /emails/batch` | Array of 1–100 transactional email objects. |
| `GET /emails/{id}` | Queue state, SMTP diagnostic, attempt count, and feedback. |
| `POST /contacts` | `{email, consentSource}`. Record existing affirmative consent. Reposting preserves any opt-out. |
| `POST /campaigns` | `{subject, text, scheduledAt?}`. Queue a newsletter for the current eligible contacts. |
| `GET /campaigns/{id}` | Campaign schedule and counts by status. |
| `PUT /automations/{event}` | `{subject, text, delaySeconds?, enabled?}`. Configure one transactional email per event. |
| `POST /events` | `{event, to}`. Queue the enabled rule's email for a backend event. |
| `POST /otp/challenges` | `{email, purpose}`. Queue a six-digit code and return the challenge ID and expiry. |
| `POST /otp/challenges/{id}/verify` | `{email, purpose, code}`. Returns `{verified}`. The code is a string. |
| `GET /lanes/{lane}` | Current pause state, reason, and timestamp. |
| `PUT /lanes/{lane}` | `{paused}`. Pause or resume new handoffs for `transactional` or `marketing`. |
| `POST /feedback` | `{messageId, event}`, where `event` is `delivered`, `hard_bounce`, or `complaint`. For a documented sender configuration rejection, send `{messageId, event: "sender_policy_block", enhancedCode}`. |

Schedules take an ISO 8601 timestamp with a timezone. Campaigns snapshot eligible contacts when queued and recheck consent and suppressions before SMTP. Already in-flight deliveries may complete after an opt-out or pause. Campaign status counts describe queue and SMTP handoff. Relay feedback is per message. Disabling an automation stops new events from queuing email. OTP challenges expire after 10 minutes and allow up to five verification attempts, with an issuance limit of one per minute and five per hour per address. Bind the successful verification to your own application session and apply per-account and per-IP limits at your application's public boundary.

## Deployment

When upgrading an existing installation, run the migration with the API and worker stopped, then restart both. The migration adds the pause metadata and feedback index.

- Run the API and worker with the same PostgreSQL database and OTP secret. Keep the API key and database off public client code. Put the API behind an HTTPS proxy and keep administrative endpoints on a trusted network when possible. Avoid logging unsubscribe tokens in proxy access logs. The Compose database settings are for local development.
- Set a per-lane rate and daily attempt budget. Workers share these limits through PostgreSQL, and the daily budget resets at midnight UTC. A relay may enforce a rolling window or a shared quota across lanes. Account for retries and other senders sharing the relay. Run workers with consistent lane settings.
- Publish and verify SPF, DKIM, and DMARC on the actual sending path. For campaign mail, configure the relay to DKIM-sign both unsubscribe headers, and verify them on a received message.
- Build a small relay adapter that verifies your provider's webhook signature, maps the original RFC Message-ID to the queued UUID, and calls `/feedback`. The API expects trusted normalized events. SMTP acceptance means the configured relay accepted the message. Receiver delivery, inbox placement, and tab placement are separate outcomes.
- Explicit SMTP 4xx responses get bounded retries. Permanent SMTP 5xx responses stop the job. A disconnected or interrupted attempt can become `uncertain`. Reconcile that status against relay logs before any manual resend. Record confirmed hard bounces through feedback so future mail is suppressed.
- Monitor lane pause state and investigate its reason before resuming. Sender configuration rejections and elevated complaint or hard-bounce feedback can pause the affected lane automatically. See [automatic sending pauses](docs/deliverability.md#automatic-sending-pauses).
- Set retention and deletion policies for message bodies, recipients, campaign records, and idempotency keys. This release has no automatic data expiry. Keep opt-outs and suppressions during cleanup. Protect backups and use a separate deployment for each organization.

## Scope

This release supports plain-text messages, one subscriber list, a single-step automation per event, and bring-your-own SMTP. It has a Resend-inspired API with its own payloads and responses. HTML and attachments, SDK compatibility, a dashboard, built-in provider webhook adapters, multi-tenant administration, and verified high-volume capacity are future work.

## Contributing

Try the API examples against your own deployment, then [share feedback or report a reproducible issue](https://github.com/Ralpberry-Labs/ralpmail/issues). To propose a change, open an issue describing the use case and run `npm test` before submitting a pull request. If the project fits your stack, star it on GitHub to follow its development.
