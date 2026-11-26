// Talking to the API: same origin (/api, proxied by Vite in development), cookies sent by the
// browser. Every error carries a message that can be shown to the user as it is.
import type { FieldKey, FlagCode, Role, TICKET_STATUSES } from '@tally/shared';
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

/** An account as GET /api/users gives it (users.service.ts). */
export interface Account extends User {
  disabledAt: string | null;
  createdAt: string;
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
  /** Kept after the month is deleted (6.4): the ready tickets and their minutes. */
  closedAt: string | null;
  summaryTicketCount: number | null;
  summaryTotalMinutes: number | null;
}

export interface MonthTicket {
  id: string;
  version: number;
  workerName: string | null;
  shiftDate: string | null;
  totalMinutes: number | null;
  status: TicketStatus;
}

export interface MonthDetail extends MonthSummary {
  workplaces: {
    groupId: string;
    name: string;
    /** How the place was written on its tickets. */
    spellings: string[];
    rows: { name: string; tickets: MonthTicket[] }[];
    unnamed: MonthTicket[];
  }[];
  /** Open "is this the same place?" questions, one per pair of places (5.3). */
  questions: {
    flagId: string;
    /** `id` is what "same place" sends as `keepGroupId`. */
    groups: {
      id: string;
      name: string;
      spellings: string[];
      tickets: number;
      ticketId: string | null;
    }[];
  }[];
  /** Morning hours typed per place (D66), under the place they ended in. */
  morning: { id: string; groupId: string; place: string; minutes: number }[];
  /** Information for the month page (D66); nothing waits on them. */
  notes: {
    rate57Unticked: { ticketId: string; name: string; place: string }[];
    sameName: { name: string; place: string }[];
  };
}

/** An entry of the workplace or names list (5.4). */
export interface ListEntry {
  name: string;
  spellings: string[];
}

/** A ticket as GET /api/tickets/:id gives it (tickets.service.ts). */
export interface Ticket {
  id: string;
  monthId: string | null;
  pageIndex: number;
  /** Another ticket (D68): not Tally's, typed in from its scan; each shift is a ticket of its own. */
  freeForm: boolean;
  shiftIndex: number;
  status: TicketStatus;
  version: number;
  firstName: string | null;
  workerName: string | null;
  workplaceRaw: string | null;
  workplaceGroupId: string | null;
  shiftDate: string | null;
  startMinutes: number | null;
  endMinutes: number | null;
  totalMinutes: number | null;
  totalFromMath: boolean;
  /** "57 rate" as a person saved it (D66); null until someone saves the ticket. */
  rate57: boolean | null;
  verifiedHow: string | null;
  createdAt: string;
  imageUrl: string;
}

export interface TicketFlag {
  id: string;
  code: FlagCode;
  field: FieldKey | null;
  detail: Record<string, unknown>;
  relatedTicketId: string | null;
  /** null while the flag is open. */
  resolvedAt: string | null;
}

export interface TicketDetail extends Ticket {
  suggestions: Partial<Record<FieldKey, string>>;
  flags: TicketFlag[];
  /** The tickets it may duplicate (for another ticket: any of its shifts may). */
  related: Ticket[];
  /** Another ticket's shifts, in order; empty for a Tally ticket (D68). */
  shifts: Shift[];
}

/** A shift of another ticket, with its open flags (D68). */
export interface Shift extends Omit<Ticket, 'imageUrl'> {
  flags: Omit<TicketFlag, 'resolvedAt'>[];
  /** Removed, or in a month being closed: shown, never changed. */
  readOnly: boolean;
}

/** GET /api/tickets: a page of 50, with each ticket's open flags. */
export interface TicketPage {
  total: number;
  tickets: (Omit<Ticket, 'imageUrl'> & { flags: { code: FlagCode; field: FieldKey | null }[] })[];
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
  if (!res.ok) throw refusal(res, data);
  return data as T;
}

function refusal(res: Response, data: unknown) {
  const message = (data as { message?: unknown } | undefined)?.message;
  return new ApiError(
    res.status,
    res.status < 500 && typeof message === 'string' ? message : BROKEN,
  );
}

/**
 * Saves a file from the API, named as the server names it. A refusal throws the server's message,
 * as `api` does, instead of the browser showing it as a page.
 */
export async function download(path: string, name: string) {
  let res: Response;
  try {
    res = await fetch(path);
  } catch {
    throw new ApiError(0, OFFLINE);
  }
  if (!res.ok) throw refusal(res, await res.json().catch(() => undefined));
  const disposition = res.headers.get('content-disposition') ?? '';
  const file = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = file;
  // A Hebrew name comes as filename* (RFC 5987).
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  a.download = /filename="([^"]+)"/.exec(disposition)?.[1] ?? name;
  if (encoded) {
    try {
      a.download = decodeURIComponent(encoded);
    } catch {
      a.download = name; // a broken name: the page's own
    }
  }
  a.click();
  // Freed at once, some browsers cancel the download before it starts.
  setTimeout(() => URL.revokeObjectURL(file), 60_000);
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
    // A month being closed is asked again until it is gone.
    refetchInterval: (q) => (q.state.data?.status === 'closing' ? POLL_MS : refetchInterval()),
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
