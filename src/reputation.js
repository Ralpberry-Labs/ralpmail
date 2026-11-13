// These are local safety thresholds based on relay feedback, with a minimum
// event count to avoid stopping a lane on a single complaint or bounce.
export async function pauseOnFeedback(client, lane) {
  const locked = await client.query(
    'SELECT lane FROM lane_limits WHERE lane = $1 AND NOT paused FOR UPDATE', [lane],
  );
  if (!locked.rowCount) return;

  const { rows: [sample] } = await client.query(
    `SELECT count(*)::integer AS total,
       count(*) FILTER (WHERE feedback = 'complaint')::integer AS complaints,
       count(*) FILTER (WHERE feedback = 'hard_bounce')::integer AS bounces
     FROM messages WHERE lane = $1 AND started_at >= now() - interval '24 hours'
       AND status IN ('sending', 'accepted', 'uncertain')
       AND (status <> 'sending' OR feedback IS NOT NULL)`, [lane],
  );
  if (sample.complaints >= 2 && sample.complaints * 1000 >= sample.total) {
    await pauseLane(client, lane, 'complaint_rate');
  } else if (sample.bounces >= 5 && sample.bounces * 50 >= sample.total) {
    await pauseLane(client, lane, 'hard_bounce_rate');
  }
}

export async function pauseLane(db, lane, reason) {
  await db.query(
    'UPDATE lane_limits SET paused = true, pause_reason = $2, paused_at = now() WHERE lane = $1 AND NOT paused',
    [lane, reason],
  );
}

// Gmail documents these codes for sender configuration failures. Extract only
// the enhanced code and discard free-form SMTP replies, which can contain PII.
const policyCodes = new Set([
  '4.7.23', '4.7.27', '4.7.29', '4.7.30', '4.7.31', '4.7.32',
  '5.7.25', '5.7.27', '5.7.29', '5.7.30',
]);

export function smtpEnhancedCode(error) {
  const match = typeof error.response === 'string' &&
    /^([45]\d\d)[ -]([45]\.\d{1,3}\.\d{1,3})(?=\s|$)/.exec(error.response);
  if (!match || Number(match[1]) !== Number(error.responseCode) || match[1][0] !== match[2][0]) return null;
  return match[2];
}

export function isSenderPolicyCode(code) {
  return policyCodes.has(code);
}
