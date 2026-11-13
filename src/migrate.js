import { readFile } from 'node:fs/promises';
import { database, transaction } from './db.js';

const pool = database(process.env.DATABASE_URL);
try {
  await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(761423)');
    await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
  });
} finally {
  await pool.end();
}
