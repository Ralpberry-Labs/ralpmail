import { createHmac, timingSafeEqual } from 'node:crypto';

export function matches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function otpCode(secret, id) {
  const digest = createHmac('sha256', secret).update('ralpmail/otp/' + id).digest();
  return String(digest.readUIntBE(0, 6) % 1_000_000).padStart(6, '0');
}
