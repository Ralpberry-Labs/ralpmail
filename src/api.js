import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { z } from 'zod';
import { email, lanes } from './config.js';
import { transaction } from './db.js';
import { matches, otpCode } from './otp.js';

const subject = z.string().trim().min(1).max(250).regex(/^[^\x00-\x1f\x7f]+$/u);
const body = z.string().min(1).max(32_000);
const sendAt = z.iso.datetime({ offset: true }).optional();
const message = z.object({ to: email, subject, text: body, scheduledAt: sendAt }).strict();
const id = z.uuid();
const purpose = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);

function problem(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function buildApi(pool, { apiKey, otpSecret, feedbackKey, logger = false }) {
  const app = Fastify({ logger, bodyLimit: 4_000_000, requestTimeout: 15_000 });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' },
    (_request, value, done) => done(null, new URLSearchParams(value)));
  app.addContentTypeParser(/^multipart\/form-data(?:;|$)/, { parseAs: 'buffer', bodyLimit: 1024 },
    async (request, value) => {
      const parsed = await new Response(value, {
        headers: { 'Content-Type': request.headers['content-type'] },
      }).formData().catch(() => { throw problem(400, 'Invalid form'); });
      return parsed;
    });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: 'Invalid input',
        fields: error.issues.map(({ path, code }) => ({ path, code })),
      });
    }
    const status = error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) request.log.error({ code: error.code }, 'Request failed');
    return reply.code(status).send({ error: status === 500 ? 'Internal error' : error.message });
  });

  function authorize(request, key) {
    if (!key || !matches(request.headers.authorization, 'Bearer ' + key)) {
      throw problem(401, 'Unauthorized');
    }
  }

  function enqueue(route, schema, action) {
    app.post(route, async (request, reply) => {
      authorize(request, apiKey);
      const input = schema.parse(request.body);
      const key = z.string().regex(/^[\x21-\x7e]{1,128}$/).parse(request.headers['idempotency-key']);
      const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const result = await transaction(pool, async (client) => {
        const scopedKey = route + '/' + key;
        const inserted = await client.query(
          'INSERT INTO requests (key, fingerprint) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [scopedKey, fingerprint],
        );
        if (!inserted.rowCount) {
          const { rows: [previous] } = await client.query(
            'SELECT fingerprint, response FROM requests WHERE key = $1', [scopedKey],
          );
          if (previous.fingerprint !== fingerprint) throw problem(409, 'Idempotency key already used');
          return previous.response;
        }
        const response = await action(client, input);
        await client.query('UPDATE requests SET response = $2 WHERE key = $1', [scopedKey, response]);
        return response;
      });
      return reply.code(202).send(result);
    });
  }

  enqueue('/emails', message, async (client, input) => {
    const { rows: [job] } = await client.query(
      `INSERT INTO messages (lane, recipient, subject, body, send_at)
       VALUES ('transactional', $1, $2, $3, COALESCE($4, now())) RETURNING id`,
      [input.to, input.subject, input.text, input.scheduledAt],
    );
    return job;
  });

  enqueue('/emails/batch', z.array(message).min(1).max(100), async (client, input) => {
    const jobs = input.map((item) => ({ ...item, id: randomUUID() }));
    await client.query(
      `INSERT INTO messages (id, lane, recipient, subject, body, send_at)
       SELECT id, 'transactional', "to", subject, text, COALESCE("scheduledAt", now())
       FROM jsonb_to_recordset($1) AS j(id uuid, "to" text, subject text, text text, "scheduledAt" timestamptz)`,
      [JSON.stringify(jobs)],
    );
    return { data: jobs.map(({ id }) => ({ id })) };
  });

  app.post('/contacts', async (request, reply) => {
    authorize(request, apiKey);
    const input = z.object({ email, consentSource: z.string().trim().min(1).max(300) }).strict()
      .parse(request.body);
    const result = await pool.query(
      'INSERT INTO contacts (email, consent_source) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [input.email, input.consentSource],
    );
    return reply.code(result.rowCount ? 201 : 200).send({ email: input.email });
  });

  enqueue('/campaigns', z.object({ subject, text: body, scheduledAt: sendAt }).strict(),
    async (client, input) => {
      const id = randomUUID();
      await client.query(
        'INSERT INTO campaigns (id, subject, body, scheduled_at) VALUES ($1, $2, $3, COALESCE($4, now()))',
        [id, input.subject, input.text, input.scheduledAt],
      );
      const jobs = await client.query(
        `INSERT INTO messages (lane, recipient, campaign_id, send_at)
         SELECT 'marketing', contacts.email, campaigns.id, campaigns.scheduled_at
         FROM contacts CROSS JOIN campaigns
         WHERE campaigns.id = $1 AND contacts.unsubscribed_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM suppressions WHERE suppressions.email = contacts.email)`,
        [id],
      );
      return { id, recipients: jobs.rowCount };
    });

  const eventName = z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/);
  app.put('/automations/:event', async (request) => {
    authorize(request, apiKey);
    const event = eventName.parse(request.params.event);
    const rule = z.object({
      subject, text: body, delaySeconds: z.number().int().min(0).max(2_592_000).default(0),
      enabled: z.boolean().default(true),
    }).strict().parse(request.body);
    await pool.query(
      `INSERT INTO automations (event, subject, body, delay_seconds, enabled) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (event) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body,
       delay_seconds = EXCLUDED.delay_seconds, enabled = EXCLUDED.enabled`,
      [event, rule.subject, rule.text, rule.delaySeconds, rule.enabled],
    );
    return { event, ...rule };
  });

  enqueue('/events', z.object({ event: eventName, to: email }).strict(), async (client, input) => {
    const { rows: [job] } = await client.query(
      `INSERT INTO messages (lane, recipient, subject, body, send_at)
       SELECT 'transactional', $2, subject, body, now() + delay_seconds * interval '1 second'
       FROM automations WHERE event = $1 AND enabled RETURNING id`, [input.event, input.to],
    );
    if (!job) throw problem(404, 'Active automation not found');
    return job;
  });

  enqueue('/otp/challenges', z.object({ email, purpose }).strict(), async (client, input) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 91627))', [input.email]);
    const { rows: [usage] } = await client.query(
      `SELECT count(*)::integer AS count, max(created_at) > now() - interval '1 minute' AS recent
       FROM challenges WHERE email = $1 AND created_at > now() - interval '1 hour'`, [input.email],
    );
    if (usage.count >= 5 || usage.recent) throw problem(429, 'OTP issuance limit reached');
    const id = randomUUID();
    const { rows: [challenge] } = await client.query(
      `INSERT INTO challenges (id, email, purpose, expires_at)
       VALUES ($1, $2, $3, now() + interval '10 minutes') RETURNING id, expires_at AS "expiresAt"`,
      [id, input.email, input.purpose],
    );
    await client.query(
      "INSERT INTO messages (lane, recipient, challenge_id) VALUES ('transactional', $1, $2)",
      [input.email, id],
    );
    return challenge;
  });

  app.post('/otp/challenges/:id/verify', async (request) => {
    authorize(request, apiKey);
    const challengeId = id.parse(request.params.id);
    const input = z.object({ email, purpose, code: z.string().regex(/^\d{6}$/) }).strict().parse(request.body);
    const valid = matches(input.code, otpCode(otpSecret, challengeId));
    const result = await pool.query(
      `UPDATE challenges SET attempts = attempts + 1, used_at = CASE WHEN $4 THEN now() END
       WHERE id = $1 AND email = $2 AND purpose = $3 AND expires_at > now()
       AND used_at IS NULL AND attempts < 5`, [challengeId, input.email, input.purpose, valid],
    );
    return { verified: valid && result.rowCount === 1 };
  });

  app.get('/emails/:id', async (request) => {
    authorize(request, apiKey);
    const { rows: [job] } = await pool.query(
      'SELECT id, status, feedback, diagnostic, attempts, send_at, finished_at FROM messages WHERE id = $1',
      [id.parse(request.params.id)],
    );
    if (!job) throw problem(404, 'Message not found');
    return job;
  });

  app.get('/campaigns/:id', async (request) => {
    authorize(request, apiKey);
    const campaignId = id.parse(request.params.id);
    const { rows: [campaign] } = await pool.query(
      'SELECT id, scheduled_at FROM campaigns WHERE id = $1', [campaignId],
    );
    if (!campaign) throw problem(404, 'Campaign not found');
    const { rows } = await pool.query(
      'SELECT status, count(*)::integer AS total FROM messages WHERE campaign_id = $1 GROUP BY status',
      [campaignId],
    );
    return { ...campaign, counts: Object.fromEntries(rows.map(({ status, total }) => [status, total])) };
  });

  app.put('/lanes/:lane', async (request) => {
    authorize(request, apiKey);
    const lane = z.enum(lanes).parse(request.params.lane);
    const { paused } = z.object({ paused: z.boolean() }).strict().parse(request.body);
    await pool.query('UPDATE lane_limits SET paused = $2 WHERE lane = $1', [lane, paused]);
    return { lane, paused };
  });

  app.post('/feedback', async (request, reply) => {
    authorize(request, feedbackKey);
    const { messageId, event } = z.object({
      messageId: id, event: z.enum(['delivered', 'hard_bounce', 'complaint']),
    }).strict().parse(request.body);
    await transaction(pool, async (client) => {
      const { rows: [job] } = await client.query(
        "SELECT recipient, lane FROM messages WHERE id = $1 AND status IN ('sending','accepted','uncertain') FOR UPDATE",
        [messageId],
      );
      if (!job) throw problem(404, 'Sent message not found');
      await client.query(
        `UPDATE messages SET feedback = CASE
          WHEN feedback = 'complaint' OR $2 = 'complaint' THEN 'complaint'
          WHEN feedback = 'hard_bounce' OR $2 = 'hard_bounce' THEN 'hard_bounce'
          ELSE 'delivered' END WHERE id = $1`, [messageId, event],
      );
      if (event === 'hard_bounce' || (event === 'complaint' && job.lane === 'transactional')) {
        await client.query(
          'INSERT INTO suppressions (email, reason) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET reason = EXCLUDED.reason',
          [job.recipient, event],
        );
      }
      if (event === 'complaint') {
        await client.query(
          'UPDATE contacts SET unsubscribed_at = now() WHERE email = $1 AND unsubscribed_at IS NULL',
          [job.recipient],
        );
        // Keep the block even if the recipient has no contact record yet.
        if (job.lane === 'marketing') {
          await client.query(
            "INSERT INTO suppressions (email, reason) VALUES ($1, 'marketing_complaint') ON CONFLICT DO NOTHING",
            [job.recipient],
          );
        }
      }
    });
    return reply.code(204).send();
  });

  app.get('/unsubscribe/:token', async (request, reply) => {
    id.parse(request.params.token);
    return reply.header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store').type('text/html').send(
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Unsubscribe</title>' +
      '<h1>Unsubscribe from marketing email</h1><form method="post">' +
      '<button name="List-Unsubscribe" value="One-Click">Unsubscribe</button></form></html>',
    );
  });

  app.post('/unsubscribe/:token', async (request, reply) => {
    const token = id.parse(request.params.token);
    if (request.body?.get?.('List-Unsubscribe') !== 'One-Click') throw problem(400, 'Invalid unsubscribe');
    await pool.query(
      'UPDATE contacts SET unsubscribed_at = now() WHERE unsubscribe_token = $1 AND unsubscribed_at IS NULL',
      [token],
    );
    return reply.header('Cache-Control', 'no-store').type('text/plain').send('Unsubscribed.');
  });

  app.get('/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });
  return app;
}
