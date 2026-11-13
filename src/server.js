import { buildApi } from './api.js';
import { serverConfig } from './config.js';
import { database } from './db.js';

const pool = database(process.env.DATABASE_URL);
const app = buildApi(pool, { ...serverConfig(process.env), logger: { disableRequestLogging: true } });
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    await app.close();
    await pool.end();
  });
}
await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3000) });
