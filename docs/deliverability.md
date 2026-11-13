# Deliverability research and rollout

Reviewed November 2026. The receiving mailbox provider decides how to handle each message. Track SMTP acceptance, delivery feedback, spam complaints, and inbox or tab placement as distinct outcomes.

## What puts mail at risk

| Signal | What to do |
| --- | --- |
| Authentication or identity failure | Publish SPF for the actual envelope sender, sign with DKIM, and publish DMARC. Make the visible From domain align with the authenticated SPF or DKIM domain. Verify TLS and matching forward/reverse DNS for the sending IP. A relay normally operates that IP and its PTR records. |
| Unwanted mail and spam reports | Send campaigns to affirmative subscribers who expect the content and frequency. Preserve consent records, avoid bought lists, and process unsubscribes and complaints promptly. Google recommends keeping Postmaster spam rates below 0.1% and avoiding 0.3% or higher. Yahoo requires below 0.3%. |
| Bounces and sudden volume changes | Feed confirmed hard bounces back into suppression. Ramp steadily using recent engaged subscribers, keep volume consistent, and review provider-specific deferrals before increasing throughput. |
| Deceptive content or mixed intent | Use accurate From names, subjects, and clear links. Give transactional and marketing mail separate sender identities, and use separate relay streams or IP pools where available. Keep promotions out of OTPs and receipts. |
| Missing unsubscribe support | Marketing mail needs a visible link in the body and, for Gmail bulk senders, RFC 8058 one-click POST support. The DKIM signature must cover both list unsubscribe headers. Gmail expects requests to be honored within 48 hours. RalpMail records a valid request immediately and checks it again before handoff. |

Sources: [Gmail sender guidelines](https://support.google.com/mail/answer/81126), [Gmail bulk-sender FAQ](https://support.google.com/mail/answer/14229414), [Yahoo Sender Hub](https://senders.yahooinc.com/best-practices/), [Microsoft Outlook authentication guidance](https://support.microsoft.com/en-us/outlook/fix-ndr-error-550-5-7-515-in-outlook-com), [RFC 8058](https://www.rfc-editor.org/rfc/rfc8058).

Gmail counts close to 5,000 messages or more to personal Gmail accounts in 24 hours across the same primary domain. Once classified, the domain retains bulk sender status. Gmail uses Promotions for offers and other promotional mail, and Updates for many automatic notifications. These are inbox tabs. Test categories separately from spam placement, and expect variation across recipients and their settings. Google publishes sender requirements and recommendations. It does not publish a complete model that predicts placement for a given subject or template. [Gmail bulk-sender FAQ](https://support.google.com/mail/answer/14229414) · [Gmail categories](https://support.google.com/mail/answer/3094499)

## How the economics work

Resend bundles a sending API, SMTP infrastructure, domain setup, contact and broadcast tools, automations, and delivery webhooks. Its transactional free tier lists 100 sends/day and 3,000/month. RalpMail supplies an API, queue, scheduled campaigns, event rules, and OTP verification. The operator supplies infrastructure, sending reputation, and feedback integration. Managed relays can charge per recipient and enforce sending quotas. Running a mail transfer agent yourself shifts costs to servers, IPs, and ongoing mail operations. [Resend API](https://resend.com/docs/api-reference/emails/send-email) · [Resend pricing](https://resend.com/pricing) · [Amazon SES pricing](https://aws.amazon.com/ses/pricing/) · [Amazon SES quotas](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html)

## Experiment before increasing volume

1. Use test inboxes you control at Gmail, Outlook.com, and Yahoo. Inspect the received headers for aligned authentication, a valid Message-ID, and the two signed unsubscribe headers on marketing mail. Exercise both the one-click POST and visible unsubscribe flow. Confirm relay feedback changes suppression before the next handoff.
2. Send to a small, engaged group of real opt-in recipients. Record accepted, delivered, hard-bounced, deferred, complained, and unsubscribed separately by stream and mailbox provider. Use [Google Postmaster Tools](https://postmaster.google.com/) for Gmail complaint and reputation signals. Small samples can leave those dashboards sparse. Seed inboxes help diagnose rendering and routing. Their placement alone cannot estimate placement across the full subscriber list.
3. Increase volume gradually only after reviewing complaint trends, authentication, deferrals, bounce patterns, and opt-out processing. Test content variants with comparable opt-in cohorts and keep sending identity and cadence stable. Pause the affected lane if signals deteriorate, then diagnose from relay responses and provider dashboards before resuming.
4. Load-test the queue against an isolated SMTP sink before any real ramp. At 10,000 recipients/day the 24-hour average is 0.116/sec. At 1,000,000/day it is 11.6/sec. In an eight-hour window those averages rise to 0.35 and 34.7/sec, before retries. Measure queue age, OTP expiry, SMTP latency, database contention, and recovery under peak concurrency. Benchmark large campaign fan-out, set a queue retention policy, and validate sustained capacity, provider quotas, and failure recovery. These rates are planning targets.
