// T2.1: routing, login, logout and the invite page, against a fake API (no network).
import { QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createQueryClient, safeNext } from './api.ts';
import { routes } from './routes.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Reply = { status: number; body?: unknown } | 'offline';
const ADMIN = { id: 'u1', email: 'admin@example.com', role: 'admin' };
const REVIEWER = { id: 'u2', email: 'reviewer@example.com', role: 'reviewer' };

let replies: Record<string, Reply>;
let calls: { method: string; path: string; headers: Headers; body: unknown }[];
let root: Root;
let container: HTMLDivElement;
let router: ReturnType<typeof createMemoryRouter>;
let client: ReturnType<typeof createQueryClient>;

beforeEach(() => {
  replies = {};
  calls = [];
  document.cookie = 'tally_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, headers: new Headers(init.headers), body });
      const reply = replies[`${method} ${path}`] ?? { status: 404, body: { message: 'Not found' } };
      if (reply === 'offline') throw new TypeError('Failed to fetch');
      const text = reply.body === undefined ? null : JSON.stringify(reply.body);
      return new Response(text, { status: reply.status });
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function open(path: string) {
  container = document.createElement('div');
  document.body.append(container);
  router = createMemoryRouter(routes, { initialEntries: [path] });
  root = createRoot(container);
  client = createQueryClient();
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function settle() {
  for (let i = 0; i < 5; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
}

const text = () => container.textContent ?? '';
const url = () => router.state.location.pathname + router.state.location.search;
const button = (label: string) =>
  [...container.querySelectorAll('button, a')].find((b) => b.textContent === label) as
    HTMLElement | undefined;

async function type(label: string, value: string) {
  const input = [...container.querySelectorAll('input')].find((i) =>
    i.labels?.[0]?.textContent?.startsWith(label),
  )!;
  await act(async () => {
    // React tracks the value itself; set it the way the browser does so onChange fires.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(label: string) {
  await act(async () => button(label)!.click());
  await settle();
}

describe('without a session', () => {
  it('sends the visitor to the login page and back after logging in', async () => {
    replies['GET /api/auth/me'] = { status: 401, body: { message: 'Please log in.' } };
    await open('/workplaces');
    expect(url()).toBe('/login?next=%2Fworkplaces');
    expect(text()).not.toContain('You were logged out');

    replies['POST /api/auth/login'] = { status: 200, body: REVIEWER };
    await type('Email', 'reviewer@example.com');
    await type('Password', 'a password');
    await click('Log in');
    expect(calls.at(-1)?.body).toEqual({ email: 'reviewer@example.com', password: 'a password' });
    expect(url()).toBe('/workplaces');
    expect(text()).toContain('reviewer@example.com');
  });

  it('shows "Checking your login…" while it asks', async () => {
    replies['GET /api/auth/me'] = { status: 401 };
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(() => {}));
    await open('/');
    expect(text()).toContain('Checking your login…');
  });
});

describe('the login page', () => {
  beforeEach(() => {
    replies['GET /api/auth/me'] = { status: 401, body: { message: 'Please log in.' } };
  });

  it('shows a wrong password', async () => {
    replies['POST /api/auth/login'] = {
      status: 401,
      body: { message: 'Email or password is wrong.' },
    };
    await open('/login');
    await type('Email', 'a@example.com');
    await type('Password', 'wrong');
    await click('Log in');
    expect(text()).toContain('Email or password is wrong.');
    expect(url()).toBe('/login');
  });

  it('shows the lockout message as the server words it', async () => {
    const message = 'Too many wrong passwords. Try again in 15 minutes.';
    replies['POST /api/auth/login'] = { status: 429, body: { message } };
    await open('/login');
    await type('Email', 'a@example.com');
    await type('Password', 'wrong');
    await click('Log in');
    expect(text()).toContain(message);
  });

  it('refuses an empty password before asking the server', async () => {
    await open('/login');
    await type('Email', 'a@example.com');
    await click('Log in');
    expect(text()).toContain('Type your password.');
    expect(calls.some((c) => c.path === '/api/auth/login')).toBe(false);
  });

  it('says when the server cannot be reached', async () => {
    replies['POST /api/auth/login'] = 'offline';
    await open('/login');
    await type('Email', 'a@example.com');
    await type('Password', 'a password');
    await click('Log in');
    expect(text()).toContain('Cannot reach the server. Check your connection and try again.');
  });

  it('ignores a "next" address on another site', async () => {
    replies['POST /api/auth/login'] = { status: 200, body: REVIEWER };
    await open('/login?next=%2F%2Fevil.com');
    await type('Email', 'a@example.com');
    await type('Password', 'a password');
    await click('Log in');
    expect(url()).toBe('/');
  });
});

describe('safeNext', () => {
  it('keeps pages of this site and drops other sites', () => {
    expect(safeNext('/workplaces?x=1')).toBe('/workplaces?x=1');
    expect(safeNext('//evil.com')).toBe('/');
    expect(safeNext('/\\evil.com')).toBe('/');
    expect(safeNext('https://evil.com/')).toBe('/');
    expect(safeNext(null)).toBe('/');
    expect(safeNext('http://[')).toBe('/');
  });
});

describe('logged in', () => {
  it('shows Admin to an admin only', async () => {
    replies['GET /api/auth/me'] = { status: 200, body: ADMIN };
    await open('/');
    expect(button('Admin')).toBeDefined();
    act(() => root.unmount());
    container.remove();

    replies['GET /api/auth/me'] = { status: 200, body: REVIEWER };
    await open('/admin');
    expect(button('Admin')).toBeUndefined();
    expect(text()).toContain('Only an admin can open this page.');
  });

  it('logs out with the CSRF token and goes to the login page', async () => {
    document.cookie = 'tally_csrf=abc';
    replies['GET /api/auth/me'] = { status: 200, body: REVIEWER };
    replies['POST /api/auth/logout'] = { status: 204 };
    await open('/');
    replies['GET /api/auth/me'] = { status: 401 };
    await click('Log out');
    const logout = calls.find((c) => c.path === '/api/auth/logout')!;
    expect(logout.headers.get('x-csrf-token')).toBe('abc');
    expect(calls.find((c) => c.method === 'GET')!.headers.get('x-csrf-token')).toBeNull();
    expect(url()).toBe('/login');
    expect(text()).not.toContain('You were logged out');
  });

  it('sends the user to log in with a notice when the session ends', async () => {
    replies['GET /api/auth/me'] = { status: 200, body: REVIEWER };
    await open('/workplaces');
    await act(async () => {
      const ended = () => Promise.reject(new ApiError(401, 'Please log in.'));
      await client.fetchQuery({ queryKey: ['months'], queryFn: ended }).catch(() => {});
    });
    await settle();
    expect(url()).toBe('/login?next=%2Fworkplaces&expired=1');
    expect(text()).toContain('You were logged out. Please log in again.');
  });

  it('links the ticket template download', async () => {
    replies['GET /api/auth/me'] = { status: 200, body: REVIEWER };
    await open('/template');
    expect(button('Download the ticket PDF')?.getAttribute('href')).toBe('/api/templates/v1/pdf');
  });

  it('says so when a page does not exist', async () => {
    replies['GET /api/auth/me'] = { status: 200, body: REVIEWER };
    await open('/nowhere');
    expect(text()).toContain('That page does not exist.');
  });
});

describe('the invite page', () => {
  it('reads the token from the link, sets the password and logs in', async () => {
    replies['GET /api/auth/me'] = { status: 401 };
    replies['POST /api/auth/accept-invite'] = { status: 200, body: REVIEWER };
    await open('/accept-invite#token=tok123');
    expect(router.state.location.hash).toBe('');
    await type('New password', 'a long password');
    await type('Type it again', 'a long password');
    await click('Set password');
    expect(calls.at(-1)?.body).toEqual({ token: 'tok123', password: 'a long password' });
    expect(url()).toBe('/');
  });

  it('checks the password before sending it', async () => {
    await open('/accept-invite#token=tok123');
    await type('New password', 'short');
    await type('Type it again', 'short');
    await click('Set password');
    expect(text()).toContain('The password needs at least 12 characters.');
    await type('New password', 'a long password');
    await type('Type it again', 'another password');
    await click('Set password');
    expect(text()).toContain('The two passwords are not the same.');
    expect(calls.some((c) => c.path === '/api/auth/accept-invite')).toBe(false);
  });

  it('shows the server message for a used link', async () => {
    const message = 'This invite link is not valid or has expired. Ask for a new one.';
    replies['POST /api/auth/accept-invite'] = { status: 400, body: { message } };
    await open('/accept-invite#token=old');
    await type('New password', 'a long password');
    await type('Type it again', 'a long password');
    await click('Set password');
    expect(text()).toContain(message);
  });

  it('shows no form without a token', async () => {
    await open('/accept-invite');
    expect(text()).toContain('This invite link is not valid or has expired. Ask for a new one.');
    expect(container.querySelector('input')).toBeNull();
  });
});
