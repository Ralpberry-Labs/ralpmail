import nodemailer from 'nodemailer';
import { transaction } from './db.js';
import { otpCode } from './otp.js';

export function smtpTransport({ url }) {
  const secure = url.protocol === 'smtps:';
  return nodemailer.createTransport({
    host: url.hostname,
    port: Number(url.port) || (secure ? 465 : 587),
    secure,
    requireTLS: !secure,
    auth: url.username ? {
      user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password),
    } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    pool: true,
    maxConnections: 1,
    maxRequeues: 0,
  });
}

async function claim(pool, lane, config) {
  return transaction(pool, async (client) => {
    const { rowCount } = await client.query(
      `SELECT lane FROM lane_limits WHERE lane = $1 AND NOT paused AND next_at <= now()
       AND (quota_day IS DISTINCT FROM (now() AT TIME ZONE 'UTC')::date OR attempts < $2)
       FOR UPDATE SKIP LOCKED`, [lane, config.daily],
    );
    if (!rowCount) return null;
    const { rows: [job] } = await client.query(
      `SELECT id FROM messages WHERE lane = $1 AND status = 'queued' AND send_at <= now()
       ORDER BY send_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`, [lane],
    );
    if (!job) return null;
    await client.query(
      `UPDATE lane_limits SET next_at = now() + $2 * interval '1 millisecond',
       attempts = CASE WHEN quota_day = (now() AT TIME ZONE 'UTC')::date THEN attempts + 1 ELSE 1 END,
       quota_day = (now() AT TIME ZONE 'UTC')::date WHERE lane = $1`,
      [lane, 1000 / config.rate],
    );
    await client.query(
      "UPDATE messages SET status = 'sending', started_at = now(), attempts = attempts + 1 WHERE id = $1",
      [job.id],
    );
    return job.id;
  });
}

async function finish(pool, id, status, diagnostic = null, retrySeconds = null) {
  await pool.query(
    `UPDATE messages SET status = $2, diagnostic = $3,
     finished_at = CASE WHEN $2 = 'queued' THEN NULL ELSE now() END,
     send_at = CASE WHEN $2 = 'queued' THEN now() + $4 * interval '1 second' ELSE send_at END
     WHERE id = $1 AND status IN ('sending', 'uncertain')`,
    [id, status, diagnostic, retrySeconds],
  );
}

export async function deliverOne(pool, lane, config, transport, otpSecret) {
  const id = await claim(pool, lane, config);
  if (!id) return false;
  const { rows: [job] } = await pool.query(
    `SELECT m.*, COALESCE(m.subject, a.subject) AS subject, COALESCE(m.body, a.body) AS body,
     c.unsubscribe_token, c.unsubscribed_at, s.reason,
     o.id AS active_challenge, o.expires_at > now() AND o.used_at IS NULL AND o.attempts < 5 AS otp_valid,
     l.paused
     FROM messages m LEFT JOIN campaigns a ON a.id = m.campaign_id
     LEFT JOIN contacts c ON c.email = m.recipient
     LEFT JOIN suppressions s ON s.email = m.recipient
     LEFT JOIN challenges o ON o.id = m.challenge_id
     JOIN lane_limits l ON l.lane = m.lane
     WHERE m.id = $1`, [id],
  );
  if (job.paused) {
    await finish(pool, id, 'queued', null, 5);
    return true;
  }
  const marketing = lane === 'marketing';
  if ((job.reason && (marketing || job.reason !== 'marketing_complaint')) ||
      (marketing && (!job.unsubscribe_token || job.unsubscribed_at))) {
    await finish(pool, id, 'suppressed');
    return true;
  }
  if (job.challenge_id && (!job.active_challenge || !job.otp_valid)) {
    await finish(pool, id, 'expired');
    return true;
  }

  const headers = {};
  let text = job.body;
  let subject = job.subject;
  if (marketing) {
    const unsubscribe = config.origin + '/unsubscribe/' + job.unsubscribe_token;
    headers['List-Unsubscribe'] = '<' + unsubscribe + '>';
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    text += '\n\nUnsubscribe: ' + unsubscribe;
  }
  if (job.challenge_id) {
    subject = 'Your verification code';
    text = 'Your verification code is ' + otpCode(otpSecret, job.challenge_id) +
      '. It expires 10 minutes after it was requested.';
  }
  const fromDomain = config.from.split('@')[1];
  let result;
  try {
    result = await transport.sendMail({
      from: config.from, to: job.recipient, subject, text, headers,
      messageId: '<' + id + '@' + fromDomain + '>',
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  } catch (error) {
    const code = Number(error.responseCode);
    if (code >= 400 && code < 500) {
      const delay = 60 * 2 ** (job.attempts - 1) + Math.floor(Math.random() * 30);
      const status = job.attempts < 5 ? 'queued' : 'failed';
      await finish(pool, id, status, 'SMTP ' + code, status === 'queued' ? delay : null);
    } else if (code >= 500 && code < 600) {
      await finish(pool, id, 'failed', 'SMTP ' + code);
    } else {
      // A connection loss after DATA can hide a successful acceptance.
      await finish(pool, id, 'uncertain', 'SMTP outcome unknown');
    }
    return true;
  }
  await finish(pool, id, result.accepted.length ? 'accepted' : 'failed');
  return true;
}

export async function markStale(pool) {
  await pool.query(
    `UPDATE messages SET status = 'uncertain', finished_at = now(), diagnostic = 'Worker interrupted'
     WHERE status = 'sending' AND started_at < now() - interval '5 minutes'`,
  );
}
