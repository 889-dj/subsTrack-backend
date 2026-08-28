import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveDomain } from './logo.js';

test('known brand aliases resolve to their real domain, including plan variants', () => {
  assert.equal(deriveDomain('Netflix'), 'netflix.com');
  assert.equal(deriveDomain('Netflix Premium'), 'netflix.com');
  assert.equal(deriveDomain('YouTube Premium'), 'youtube.com');
  assert.equal(deriveDomain('Disney+'), 'disneyplus.com');
  assert.equal(deriveDomain('Amazon Prime Video'), 'amazon.com');
  assert.equal(deriveDomain('Prime Video'), 'primevideo.com');
  assert.equal(deriveDomain('Prime'), 'primevideo.com');
  assert.equal(deriveDomain('Amazon Prime'), 'amazon.com');
});

test('unknown names fall back to a slugified .com guess', () => {
  assert.equal(deriveDomain('My Gym App'), 'mygymapp.com');
  assert.equal(deriveDomain('  Spaces   Trimmed  '), 'spacestrimmed.com');
});

test('empty or punctuation-only names have no derivable domain', () => {
  assert.equal(deriveDomain(''), undefined);
  assert.equal(deriveDomain('   '), undefined);
  assert.equal(deriveDomain('!!!'), undefined);
});
