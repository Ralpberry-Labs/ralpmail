import { z } from 'zod';

export const email = z.email().max(254).transform((value) => value.toLowerCase());
export const lanes = ['transactional', 'marketing'];

export function publicOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.href !== url.origin + '/') {
    throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a path');
  }
  return url.origin;
}

export function serverConfig(env) {
  const apiKey = z.string().min(32).parse(env.API_KEY);
  const otpSecret = z.string().min(32).parse(env.OTP_SECRET);
  const feedbackKey = env.FEEDBACK_KEY ? z.string().min(32).parse(env.FEEDBACK_KEY) : undefined;
  if (apiKey === otpSecret || feedbackKey === apiKey || feedbackKey === otpSecret) {
    throw new Error('API_KEY, OTP_SECRET, and FEEDBACK_KEY must be distinct');
  }
  return { apiKey, otpSecret, feedbackKey };
}

export function workerConfig(env) {
  const configs = Object.fromEntries(lanes.flatMap((lane) => {
    const prefix = lane.toUpperCase();
    const connection = env[prefix + '_SMTP_URL'];
    if (!connection) return [];
    const url = new URL(connection);
    if (!['smtp:', 'smtps:'].includes(url.protocol) || url.search || url.hash) {
      throw new Error(prefix + '_SMTP_URL must be an SMTP URL without query options');
    }
    return [[lane, {
      url,
      from: email.parse(env[prefix + '_FROM']),
      rate: z.coerce.number().positive().max(1000).parse(env[prefix + '_PER_SECOND'] ?? 1),
      daily: z.coerce.number().int().positive().max(100_000_000).parse(env[prefix + '_DAILY_ATTEMPTS'] ?? 1000),
    }]];
  }));
  if (!Object.keys(configs).length) throw new Error('Configure at least one SMTP lane');
  if (configs.marketing) {
    configs.marketing.origin = publicOrigin(env.PUBLIC_ORIGIN);
    if (configs.marketing.from === configs.transactional?.from) {
      throw new Error('Use different From addresses for marketing and transactional mail');
    }
  }
  return configs;
}
