import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from './app.js';

test('liveness responds without touching dependencies and includes security headers', async () => {
  const app = buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
    assert.ok(response.headers['x-request-id']);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
  } finally {
    await app.close();
  }
});

test('protected routes return the stable error contract', async () => {
  const app = buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/subscriptions' });
    assert.equal(response.statusCode, 401);
    assert.match(response.headers['cache-control'] ?? '', /no-store/);
    const body = response.json();
    assert.equal(body.code, 'UNAUTHENTICATED');
    assert.equal(body.message, 'Missing bearer token.');
    assert.equal(body.requestId, response.headers['x-request-id']);
  } finally {
    await app.close();
  }
});

test('metadata exposes the mobile domain constants', async () => {
  const app = buildApp();
  try {
    const response = await app.inject({ method: 'GET', url: '/v1/meta' });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.ok(body.currencies.includes('INR'));
    assert.ok(body.categories.includes('Software'));
  } finally {
    await app.close();
  }
});
