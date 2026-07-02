import { api, getToken } from "@/lib/api";

function getUserFromToken(): { id: string; full_name: string; role: string } | null {
  const token = getToken();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return {
      id: payload.userId ?? '',
      full_name: payload.full_name ?? 'Unknown',
      role: (payload.roles as string[])?.[0] ?? 'nurse',
    };
  } catch {
    return null;
  }
}

export async function logAudit(action: string, target?: string) {
  const actor = getUserFromToken();
  if (!actor) return;
  await api.post('/audit-logs', {
    actor_id: actor.id,
    actor_name: actor.full_name,
    actor_role: actor.role,
    action,
    target: target ?? null,
  }).catch(() => { /* audit failures are non-fatal */ });
}
