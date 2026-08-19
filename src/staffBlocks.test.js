import assert from 'node:assert/strict';
import test from 'node:test';
import { postStaffBlocks } from './staffBlocks.js';

test('staff block requests use the current Supabase session and server endpoint', async () => {
  let sessionReads = 0;
  let request;
  const supabaseClient = {
    auth: {
      async getSession() {
        sessionReads += 1;
        return { data: { session: { access_token: 'fresh-access-token' } }, error: null };
      },
    },
  };
  const payload = {
    action: 'block',
    reason: 'Maintenance',
    selections: [{ date: '2030-01-15', hour: 6, courtId: 1 }],
  };

  const response = await postStaffBlocks(supabaseClient, payload, async (url, options) => {
    request = { url, options };
    return { ok: true };
  });

  assert.equal(response.ok, true);
  assert.equal(sessionReads, 1);
  assert.equal(request.url, '/api/staff-blocks');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer fresh-access-token');
  assert.deepEqual(JSON.parse(request.options.body), payload);
  assert.equal('from' in supabaseClient, false, 'the client does not need protected-table access');
});

test('staff block requests stop before fetch when no valid session remains', async () => {
  let fetchCalled = false;
  const supabaseClient = {
    auth: {
      async getSession() {
        return { data: { session: null }, error: new Error('refresh failed') };
      },
    },
  };

  await assert.rejects(
    postStaffBlocks(supabaseClient, { action: 'block', selections: [] }, async () => {
      fetchCalled = true;
    }),
    /session is no longer valid/i,
  );
  assert.equal(fetchCalled, false);
});
