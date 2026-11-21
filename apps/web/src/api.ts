// Talking to the API: same origin (/api, proxied by Vite in development), cookies sent by the
// browser. Every error carries a message that can be shown to the user as it is.
import type { Role, TICKET_STATUSES } from '@tally/shared';
import {
  MutationCache,
  QueryCache,
  QueryClient,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

export interface User {
  id: string;
  email: string;
  role: Role;
}

// The API's answers (apps/api: months.service.ts, tickets.service.ts). Dates arrive as ISO text.
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type Counts = Record<TicketStatus, number>;

export interface MonthSummary {
  id: string;
  year: number;
  month: number;
  status: 'open' | 'closing' | 'closed';
  tickets: Counts;
}

export interface MonthTicket {
  id: string;
  workerName: string | null;
  shiftDate: string | null;
  totalMinutes: number | null;
  status: TicketStatus;
}

export interface MonthDetail extends MonthSummary {
  workplaces: {
    groupId: string;
    name: string;
    rows: { name: string; tickets: MonthTicket[] }[];
    unnamed: MonthTicket[];
  }[];
}

export interface UploadProgress {
  id: string;
  filename: string;
  createdAt: string;
  /** When it last moved: a ticket sent to be read again makes an old upload active. */
  activeAt: string;
  pages: number | null;
  splitting: boolean;
  failedPages: number[];
  tickets: Counts;
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

const POLL_MS = 3000;
/** Reading in batch mode takes up to 24 hours (D26); an upload idle for longer has stopped. */
const STUCK_MS = 26 * 3600_000;
/** The organiser sorts a month into workplaces after its uploads are read, within 2 minutes (D45). */
const SORTING_MS = 2 * 60_000;

const reading = (u: UploadProgress) => u.splitting || u.tickets.processing > 0;
export const stuck = (u: UploadProgress) =>
  reading(u) && Date.now() - Date.parse(u.activeAt) > STUCK_MS;
export const unfinished = (u: UploadProgress) => reading(u) && !stuck(u);

/** Every upload still held, asked every 3 seconds while one is being read (section 8). */
export function useProgress() {
  return useQuery<UploadProgress[], ApiError>({
    queryKey: ['progress'],
    queryFn: () => api('/api/progress'),
    refetchInterval: (q) => (q.state.data?.some(unfinished) ? POLL_MS : false),
  });
}

/**
 * How often a page's counts are asked again: while an upload is being read, and for 2 minutes
 * after, while the month is sorted into workplaces. False when nothing is happening.
 */
export function useLiveInterval() {
  const client = useQueryClient();
  const busy = useProgress().data?.some(unfinished) ?? false;
  const wasBusy = useRef(false);
  const [until, setUntil] = useState(0);
  useEffect(() => {
    if (wasBusy.current && !busy) setUntil(Date.now() + SORTING_MS);
    wasBusy.current = busy;
  }, [busy]);
  // A function, checked after each answer: an upload can become stuck with no new answer.
  return () =>
    client.getQueryData<UploadProgress[]>(['progress'])?.some(unfinished) || Date.now() < until
      ? POLL_MS
      : false;
}

export function useMonths() {
  const refetchInterval = useLiveInterval();
  return useQuery<MonthSummary[], ApiError>({
    queryKey: ['months'],
    queryFn: () => api('/api/months'),
    refetchInterval,
  });
}

export function useMonth(id: string) {
  const refetchInterval = useLiveInterval();
  return useQuery<MonthDetail, ApiError>({
    queryKey: ['months', id],
    queryFn: () => api(`/api/months/${encodeURIComponent(id)}`),
    refetchInterval,
  });
}

/** How many tickets outside any month have this status (6c: waiting for a date). */
export function useWaitingCount(status: TicketStatus) {
  const refetchInterval = useLiveInterval();
  return useQuery<{ total: number }, ApiError>({
    queryKey: ['tickets', 'none', status],
    queryFn: () => api(`/api/tickets?month=none&status=${status}`),
    refetchInterval,
  });
}
