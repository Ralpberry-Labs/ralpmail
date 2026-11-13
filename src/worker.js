import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { workerConfig } from './config.js';
import { database } from './db.js';
import { deliverOne, markStale, smtpTransport } from './delivery.js';

const configs = workerConfig(process.env);
const secret = z.string().min(32).parse(process.env.OTP_SECRET);
const pool = database(process.env.DATABASE_URL);
let running = true;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { running = false; });

await markStale(pool);
const reaper = setInterval(() => {
  markStale(pool).catch(() => console.error('Could not check for interrupted sends'));
}, 30_000);
try {
  await Promise.all(Object.entries(configs).map(async ([lane, config]) => {
    const transport = smtpTransport(config);
    try {
      while (running) {
        try {
          const worked = await deliverOne(pool, lane, config, transport, secret);
          if (!worked) await sleep(Math.max(10, Math.min(250, 1000 / config.rate)));
        } catch {
          console.error('Worker error on ' + lane + ' lane');
          await sleep(1000);
        }
      }
    } finally {
      transport.close();
    }
  }));
} finally {
  clearInterval(reaper);
  await pool.end();
}
