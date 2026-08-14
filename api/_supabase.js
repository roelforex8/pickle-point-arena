import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const publishableKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;

export function getAdminClient() {
  if (!supabaseUrl || !secretKey) throw new Error('Server environment is not configured.');
  return createClient(supabaseUrl, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function authorizeStaffProfile(profile, requiredRole) {
  if (!profile?.active || !['owner', 'admin'].includes(profile.role)) {
    return { error: 'This account is not authorized.', status: 403 };
  }
  if (requiredRole && profile.role !== requiredRole) {
    return { error: 'Owner access is required.', status: 403 };
  }
  return null;
}

export async function requireStaff(request, requiredRole) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (!token) return { error: 'Authentication required.', status: 401 };

  if (!supabaseUrl || !publishableKey) return { error: 'Server authentication is not configured.', status: 500 };
  const userClient = createClient(supabaseUrl, publishableKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData.user) return { error: 'Your session is no longer valid.', status: 401 };

  const { data: profile, error: profileError } = await userClient
    .from('profiles')
    .select('id, full_name, role, active')
    .eq('id', userData.user.id)
    .single();

  if (profileError) return { error: 'This account is not authorized.', status: 403 };
  const authorizationError = authorizeStaffProfile(profile, requiredRole);
  if (authorizationError) return authorizationError;

  const admin = getAdminClient();
  return { admin, userClient, user: userData.user, profile };
}

export function sendJson(response, status, body) {
  response.status(status).setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}
