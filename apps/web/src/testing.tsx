// The pages against a fake API (no network), shared by the tests. Call useFakeApi() once per file.
import { QueryClientProvider } from '@tanstack/react-query';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, vi } from 'vitest';
import { createQueryClient } from './api.ts';
import { routes } from './routes.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Answer = { status: number; body?: unknown; headers?: Record<string, string> } | 'offline';
/** A fixed answer, or one made from the request body (e.g. a new key for each sign). */
export type Reply = Answer | ((body: unknown) => Answer);
export const ADMIN = { id: 'u1', email: 'admin@example.com', role: 'admin' };
export const REVIEWER = { id: 'u2', email: 'reviewer@example.com', role: 'reviewer' };

export let replies: Record<string, Reply>;
export let calls: { method: string; path: string; headers: Headers; body: unknown }[];
export let container: HTMLDivElement;
export let router: ReturnType<typeof createMemoryRouter>;
export let client: ReturnType<typeof createQueryClient>;
let root: Root | undefined;

export function useFakeApi() {
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
        const reply = replies[`${method} ${path}`] ?? {
          status: 404,
          body: { message: 'Not found' },
        };
        const answer = typeof reply === 'function' ? reply(body) : reply;
        if (answer === 'offline') throw new TypeError('Failed to fetch');
        const text = answer.body === undefined ? null : JSON.stringify(answer.body);
        return new Response(text, { status: answer.status, headers: answer.headers });
      }),
    );
  });

  afterEach(() => {
    close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
}

export function close() {
  if (!root) return;
  const r = root;
  root = undefined;
  act(() => r.unmount());
  container.remove();
}

export async function open(path: string) {
  container = document.createElement('div');
  document.body.append(container);
  router = createMemoryRouter(routes, { initialEntries: [path] });
  root = createRoot(container);
  client = createQueryClient();
  await act(async () => {
    // As main.tsx does: effects run twice, which hid a bug only `pnpm dev` showed.
    root!.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </StrictMode>,
    );
  });
  await settle();
}

export async function settle() {
  for (let i = 0; i < 5; i++) await act(() => new Promise((r) => setTimeout(r, 0)));
}

export const text = () => container.textContent ?? '';
export const url = () => router.state.location.pathname + router.state.location.search;
export const button = (label: string) =>
  [...container.querySelectorAll('button, a')].find((b) => b.textContent === label) as
    HTMLElement | undefined;

/** A button of the open dialog, which MUI puts outside the page's container. */
export const dialogButton = (label: string) =>
  [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === label) as
    HTMLElement | undefined;

export async function type(label: string, value: string) {
  const input = [...container.querySelectorAll('input')].find((i) =>
    i.labels?.[0]?.textContent?.startsWith(label),
  )!;
  await act(async () => {
    // React tracks the value itself; set it the way the browser does so onChange fires.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function click(label: string) {
  await act(async () => button(label)!.click());
  await settle();
}
