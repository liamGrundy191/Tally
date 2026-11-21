// Talking to the API: same origin (/api, proxied by Vite in development), cookies sent by the
// browser. Every error carries a message that can be shown to the user as it is.
import type { Role } from '@tally/shared';
import { MutationCache, QueryCache, QueryClient, useQuery } from '@tanstack/react-query';

export interface User {
  id: string;
  email: string;
  role: Role;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const OFFLINE = 'Cannot reach the server. Check your connection and try again.';
const BROKEN = 'Something went wrong on our side. Try again.';

function csrfToken() {
  const pair = document.cookie.split('; ').find((c) => c.startsWith('tally_csrf='));
  return pair ? decodeURIComponent(pair.slice('tally_csrf='.length)) : undefined;
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  // Double-submit CSRF (section 11): copy the cookie into a header on every change.
  const csrf = method === 'GET' ? undefined : csrfToken();
  if (csrf) headers['x-csrf-token'] = csrf;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, OFFLINE);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const message = (data as { message?: unknown } | undefined)?.message;
    throw new ApiError(
      res.status,
      res.status < 500 && typeof message === 'string' ? message : BROKEN,
    );
  }
  return data as T;
}

const ME = ['me'];

export function createQueryClient(): QueryClient {
  // A 401 on anything but `me` while logged in means the session ended (12 h idle): forget the
  // user, and the page guard sends them to log in again with a notice. So the API must keep 401
  // for "no session" only (a wrong current password, say, is a 400).
  const onError = (error: Error, key?: readonly unknown[]) => {
    if (!(error instanceof ApiError) || error.status !== 401 || key?.[0] === ME[0]) return;
    if (client.getQueryData(ME)) client.setQueryData(ME, null);
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: (e, q) => onError(e, q.queryKey) }),
    mutationCache: new MutationCache({ onError: (e) => onError(e) }),
    defaultOptions: {
      queries: {
        retry: (n, e) => !(e instanceof ApiError && e.status > 0 && e.status < 500) && n < 2,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
  return client;
}

/** The logged-in user. `null` means the session ended while the app was open. */
export function useMe() {
  return useQuery<User | null, ApiError>({
    queryKey: ME,
    queryFn: () => api<User>('/api/auth/me'),
    staleTime: Infinity,
    retry: false,
  });
}

/** Where to go after logging in: only a page of this site, never another site. */
export function safeNext(next: string | null): string {
  if (!next) return '/';
  try {
    const target = new URL(next, window.location.origin);
    return target.origin === window.location.origin ? target.pathname + target.search : '/';
  } catch {
    return '/'; // a malformed link, e.g. `http://[`
  }
}
