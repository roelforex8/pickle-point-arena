import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('./App.jsx', import.meta.url), 'utf8');

test('dashboard notification loading never sends DELETE /api/activity', () => {
  assert.doesNotMatch(appSource, /authorizedFetch\(['"]\/api\/activity['"],\s*\{\s*method:\s*['"]DELETE['"]/);
});

test('activity fetching and mark-as-read behavior remain present', () => {
  assert.match(appSource, /from\(['"]notifications['"]\)\.select\(/);
  assert.match(appSource, /from\(['"]notifications['"]\)\.update\(\{\s*read_at:/);
  assert.match(appSource, /window\.setInterval\(loadNotifications,\s*20000\)/);
});
