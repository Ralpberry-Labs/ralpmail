import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { after, before, test } from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import nodemailer from 'nodemailer';
import { SMTPServer } from 'smtp-server';
import { buildApi } from '../src/api.js';
import { deliverOne, markStale } from '../src/delivery.js';

const apiKey = 'test-api-key-for-local-tests-only';
const otpSecret = 'test-otp-secret-for-local-tests-only';
const feedbackKey = 'test-feedback-key-for-local-tests-only';
const config = { from: 'sender@example.test', origin: 'https://mail.example.test', rate: 1000, daily: 1000 };
const received = [];
let directory, postgres, pool, app, smtp, transport;

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ralpmail-test-'));
  postgres = new EmbeddedPostgres({
    databaseDir: join(directory, 'db'),
    port: await availablePort(), user: 'postgres', password: 'localtest',
    onLog: () => {}, onError: () => {},
  });
  await postgres.initialise();
  await postgres.start();
  pool = postgres.getPgClient();
  await pool.connect();
  // The service uses pooled clients for transactions. Reuse the connection details here.
  const options = pool.connectionParameters;
  await pool.end();
  const { default: pg } = await import('pg');
  pool = new pg.Pool({
    host: options.host, port: options.port, user: options.user,
    password: options.password, database: options.database,
  });
  await pool.query(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  app = buildApi(pool, { apiKey, otpSecret, feedbackKey });
  smtp = new SMTPServer({
    disabledCommands: ['AUTH', 'STARTTLS'],
    onData(stream, _session, callback) {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        received.push(Buffer.concat(chunks).toString());
        callback();
      });
    },
  });
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  transport = nodemailer.createTransport({ host: '127.0.0.1', port: smtp.server.address().port });
});

after(async () => {
  transport?.close();
  if (smtp) await new Promise((resolve) => smtp.close(resolve));
  await app?.close();
  await pool?.end();
  await postgres?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function request(method, url, payload, key, token = apiKey) {
  return app.inject({
    method, url, payload,
    headers: { authorization: 'Bearer ' + token, ...(key ? { 'idempotency-key': key } : {}) },
  });
}

async function run(lane, relay = transport, settings = config) {
  await pool.query('UPDATE lane_limits SET next_at = now() WHERE lane = $1', [lane]);
  return deliverOne(pool, lane, settings, relay, otpSecret);
}

test('batch requests are atomic and concurrent retries enqueue only once', async () => {
  const message = { to: 'first@example.test', subject: 'Test', text: 'Hello' };
  assert.equal((await request('POST', '/emails', message, 'bad', 'invalid')).statusCode, 401);
  const results = await Promise.all([
    request('POST', '/emails/batch', [message], 'batch-one'),
    request('POST', '/emails/batch', [message], 'batch-one'),
  ]);
  assert.equal(results[0].statusCode, 202, results[0].body);
  assert.deepEqual(results[0].json(), results[1].json());
  assert.equal((await request('POST', '/emails/batch', [{ ...message, text: 'Changed' }], 'batch-one')).statusCode, 409);
  assert.equal(await run('transactional'), true);
  assert.equal(await run('transactional'), false);
  const { id } = results[0].json().data[0];
  assert.equal((await request('GET', '/emails/' + id)).json().status, 'accepted');
  assert.match(received.at(-1), /Hello/);
});

test('scheduled automation hands off only after the scheduled time', async () => {
  const rule = { subject: 'Welcome', text: 'Your account is ready', delaySeconds: 300 };
  assert.equal((await request('PUT', '/automations/account.created', rule)).statusCode, 200);
  const response = await request('POST', '/events',
    { event: 'account.created', to: 'welcome@example.test' }, 'welcome');
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(await run('transactional'), false);
  await pool.query('UPDATE messages SET send_at = now() WHERE id = $1', [response.json().id]);
  assert.equal(await run('transactional'), true);
  assert.match(received.at(-1), /Your account is ready/);
});

test('OTP is rate limited, identity-bound, and usable once', async () => {
  const input = { email: 'otp@example.test', purpose: 'login' };
  const created = await request('POST', '/otp/challenges', input, 'otp-one');
  assert.equal(created.statusCode, 202, created.body);
  assert.equal((await request('POST', '/otp/challenges', input, 'otp-two')).statusCode, 429);
  assert.equal(await run('transactional'), true);
  const code = received.at(-1).match(/verification code is (\d{6})/)[1];
  const url = '/otp/challenges/' + created.json().id + '/verify';
  assert.equal((await request('POST', url, { ...input, purpose: 'signup', code })).json().verified, false);
  const results = await Promise.all([request('POST', url, { ...input, code }), request('POST', url, { ...input, code })]);
  assert.deepEqual(results.map((result) => result.json().verified).sort(), [false, true]);
});

test('campaign mail contains unsubscribe headers and queued sends respect unsubscribe', async () => {
  await request('POST', '/contacts', { email: 'newsletter@example.test', consentSource: 'Signup form' });
  const send = () => ({ subject: 'News', text: 'Our newsletter' });
  assert.equal((await request('POST', '/campaigns', send(), 'news-one')).json().recipients, 1);
  assert.equal(await run('marketing'), true);
  const mail = received.at(-1);
  assert.match(mail, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  const token = mail.match(/https:\/\/mail\.example\.test\/unsubscribe\/([\w-]+)/)[1];
  const url = '/unsubscribe/' + token;
  const queued = await request('POST', '/campaigns', send(), 'news-two');
  assert.equal(queued.json().recipients, 1);
  await app.inject({ method: 'GET', url });
  assert.equal((await pool.query('SELECT unsubscribed_at FROM contacts')).rows[0].unsubscribed_at, null);
  const form = new FormData();
  form.set('List-Unsubscribe', 'One-Click');
  const formRequest = new Request('https://mail.example.test' + url, { method: 'POST', body: form });
  assert.equal((await app.inject({
    method: 'POST', url, payload: Buffer.from(await formRequest.arrayBuffer()),
    headers: { 'content-type': formRequest.headers.get('content-type') },
  })).statusCode, 200);
  assert.equal(await run('marketing'), true);
  assert.deepEqual((await request('GET', '/campaigns/' + queued.json().id)).json().counts, { suppressed: 1 });
  assert.equal((await request('POST', '/campaigns', send(), 'news-three')).json().recipients, 0);
});

test('feedback suppresses an address and late delivery does not overwrite a hard bounce', async () => {
  const message = { to: 'bounce@example.test', subject: 'Test', text: 'Hello' };
  const { id } = (await request('POST', '/emails', message, 'bounce-one')).json();
  assert.equal(await run('transactional'), true);
  for (const event of ['hard_bounce', 'delivered']) {
    const result = await request('POST', '/feedback', { messageId: id, event }, null, feedbackKey);
    assert.equal(result.statusCode, 204, result.body);
  }
  assert.equal((await request('GET', '/emails/' + id)).json().feedback, 'hard_bounce');
  const next = (await request('POST', '/emails', message, 'bounce-two')).json().id;
  assert.equal(await run('transactional'), true);
  assert.equal((await request('GET', '/emails/' + next)).json().status, 'suppressed');
});

test('pause, daily budget, temporary SMTP error, ambiguous response, and interrupted worker', async () => {
  const message = { to: 'retry@example.test', subject: 'Test', text: 'Hello' };
  const { id } = (await request('POST', '/emails', message, 'retry-one')).json();
  await request('PUT', '/lanes/transactional', { paused: true });
  assert.equal(await run('transactional'), false);
  await request('PUT', '/lanes/transactional', { paused: false });
  assert.equal(await run('transactional', transport, { ...config, daily: 1 }), false);
  assert.equal(await run('transactional', {
    async sendMail() { throw Object.assign(new Error('Deferred'), { responseCode: 451 }); },
  }), true);
  const job = (await request('GET', '/emails/' + id)).json();
  assert.equal(job.status, 'queued');
  assert.equal(job.diagnostic, 'SMTP 451');
  assert.ok(Date.parse(job.send_at) > Date.now());
  await pool.query('UPDATE messages SET send_at = now() WHERE id = $1', [id]);
  assert.equal(await run('transactional', { async sendMail() { throw new Error('Disconnected'); } }), true);
  assert.equal((await request('GET', '/emails/' + id)).json().status, 'uncertain');
  await pool.query("UPDATE messages SET status = 'sending', started_at = now() - interval '6 minutes' WHERE id = $1", [id]);
  await markStale(pool);
  assert.equal((await request('GET', '/emails/' + id)).json().status, 'uncertain');
  assert.equal(await run('transactional'), false);
});

test('workers share the configured pacing limit across concurrent claims', async () => {
  const emails = ['one', 'two'].map((name) => ({ to: name + '@example.test', subject: 'Pace', text: 'Hello' }));
  const result = await request('POST', '/emails/batch', emails, 'pace');
  assert.equal(result.statusCode, 202, result.body);
  await pool.query("UPDATE lane_limits SET next_at = now() WHERE lane = 'transactional'");
  const relay = { async sendMail() { return { accepted: ['test'] }; } };
  const settings = { ...config, rate: 1 };
  const claims = await Promise.all([
    deliverOne(pool, 'transactional', settings, relay, otpSecret),
    deliverOne(pool, 'transactional', settings, relay, otpSecret),
  ]);
  assert.deepEqual(claims.sort(), [false, true]);
  assert.equal(await deliverOne(pool, 'transactional', settings, relay, otpSecret), false);
});

test('marketing complaints preserve transactional delivery unless a hard bounce arrives', async () => {
  const recipient = 'complaint@example.test';
  await request('POST', '/contacts', { email: recipient, consentSource: 'Signup form' });
  await request('POST', '/campaigns', { subject: 'News', text: 'Our newsletter' }, 'complaint-news');
  const sent = await run('marketing');
  assert.equal(sent, true);
  const { rows: [job] } = await pool.query(
    "SELECT id FROM messages WHERE recipient = $1 AND lane = 'marketing'", [recipient],
  );
  const feedback = (event) => request('POST', '/feedback', { messageId: job.id, event }, null, feedbackKey);
  assert.equal((await feedback('complaint')).statusCode, 204);
  const { rows: [contact] } = await pool.query('SELECT unsubscribed_at FROM contacts WHERE email = $1', [recipient]);
  assert.ok(contact.unsubscribed_at);
  await pool.query("UPDATE messages SET status = 'failed' WHERE status = 'queued' AND lane = 'transactional'");
  const mail = { to: recipient, subject: 'Receipt', text: 'Your receipt' };
  const first = await request('POST', '/emails', mail, 'complaint-tx-one');
  assert.equal(await run('transactional'), true);
  assert.equal((await request('GET', '/emails/' + first.json().id)).json().status, 'accepted');
  assert.equal((await feedback('hard_bounce')).statusCode, 204);
  const second = await request('POST', '/emails', mail, 'complaint-tx-two');
  assert.equal(await run('transactional'), true);
  assert.equal((await request('GET', '/emails/' + second.json().id)).json().status, 'suppressed');
});
