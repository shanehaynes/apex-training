#!/usr/bin/env node
// Create the fixed local test users on the LOCAL Supabase stack.
// Run between phase8 and phase9 (db-reset-local.sh does this): phase9's
// backfill aborts unless the shanehaynes.sah@gmail.com auth user exists.
//
// Idempotent — existing users are left alone.

import { localSupabaseEnv } from './lib/localEnv.mjs';

const { url, serviceKey } = localSupabaseEnv();

// Fixed, local-only credentials. The gmail address exists solely to satisfy
// phase9's backfill lookup; the agent users are what tests sign in as.
export const LOCAL_USERS = [
  { email: 'shanehaynes.sah@gmail.com', password: 'apex-local-owner' },
  { email: 'agent@apex.local', password: 'apex-agent-password' },
  { email: 'agent2@apex.local', password: 'apex-agent-password' },
];

const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  'Content-Type': 'application/json',
};

for (const { email, password } of LOCAL_USERS) {
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (res.ok) {
    const user = await res.json();
    console.log(`created ${email} (${user.id})`);
  } else {
    const body = await res.text();
    if (res.status === 422 && body.includes('already been registered')) {
      console.log(`exists  ${email}`);
    } else {
      console.error(`failed to create ${email}: HTTP ${res.status} ${body}`);
      process.exit(1);
    }
  }
}
