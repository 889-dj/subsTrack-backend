import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveDomain } from './logo.js';

test('known brand aliases resolve to their real domain, including plan variants', async () => {
  assert.equal(await deriveDomain('Netflix'), 'netflix.com');
  assert.equal(await deriveDomain('Netflix Premium'), 'netflix.com');
  assert.equal(await deriveDomain('YouTube Premium'), 'youtube.com');
  assert.equal(await deriveDomain('Disney+'), 'disneyplus.com');
  assert.equal(await deriveDomain('Amazon Prime Video'), 'amazon.com');
  assert.equal(await deriveDomain('Prime Video'), 'primevideo.com');
  assert.equal(await deriveDomain('Prime'), 'primevideo.com');
  assert.equal(await deriveDomain('Amazon Prime'), 'amazon.com');
});

test('empty or punctuation-only names have no derivable domain', async () => {
  assert.equal(await deriveDomain(''), undefined);
  assert.equal(await deriveDomain('   '), undefined);
});
