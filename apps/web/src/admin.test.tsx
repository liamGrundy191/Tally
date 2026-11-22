// T2.5: the Admin page (users and invites), against a fake API (no network). Emails are invented.
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN,
  button,
  calls,
  click,
  client,
  container,
  dialogButton,
  open,
  replies,
  REVIEWER,
  router,
  settle,
  text,
  type,
  useFakeApi,
} from './testing.tsx';

useFakeApi();

const account = (id: string, email: string, role: string, disabledAt: string | null = null) => ({
  id,
  email,
  role,
  disabledAt,
  createdAt: '2026-11-01T10:00:00.000Z',
});
const USERS = [
  account('u1', ADMIN.email, 'admin'),
  account('u3', 'gone@example.com', 'reviewer', '2026-11-10T10:00:00.000Z'),
  account('u2', 'reviewer@example.com', 'reviewer'),
];
const LINK = 'http://localhost:5173/accept-invite#token=secret-token';

beforeEach(() => {
  replies['GET /api/auth/me'] = { status: 200, body: ADMIN };
  replies['GET /api/users'] = { status: 200, body: USERS };
});

const row = (email: string) =>
  [...container.querySelectorAll('tbody tr')].find((r) =>
    r.textContent?.startsWith(email),
  ) as HTMLElement;
const rowButton = (email: string, label: string) =>
  [...row(email).querySelectorAll('button')].find((b) => b.textContent === label);
const changes = () => calls.filter((c) => c.method === 'PATCH');
const invites = () => calls.filter((c) => c.path === '/api/users/invite');
const linkField = () =>
  [...container.querySelectorAll('input')].find((i) => i.value.includes('#token='));

async function chooseRole(label: string) {
  const radio = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
    (r) => r.labels?.[0]?.textContent === label,
  )!;
  await act(async () => radio.click());
}

describe('the users list', () => {
  it('shows every account, with no actions on your own', async () => {
    await open('/admin');
    expect(text()).toContain('reviewer@example.com');
    expect(row('gone@example.com').textContent).toContain('Disabled');
    expect(row('reviewer@example.com').textContent).toContain('Active');
    expect(row(ADMIN.email).textContent).toContain('This is you.');
    expect(row(ADMIN.email).querySelectorAll('button')).toHaveLength(0);
    expect(rowButton('reviewer@example.com', 'Make admin')).toBeDefined();
    expect(rowButton('reviewer@example.com', 'Disable')).toBeDefined();
    expect(rowButton('gone@example.com', 'Enable')).toBeDefined();
  });

  it('asks before disabling, with the focus on Cancel; Cancel sends nothing', async () => {
    await open('/admin');
    await act(async () => rowButton('reviewer@example.com', 'Disable')!.click());
    await settle();
    expect(document.body.textContent).toContain(
      'Disable reviewer@example.com? They are logged out at once and cannot log in until an admin enables them again.',
    );
    expect(document.activeElement).toBe(dialogButton('Cancel'));
    await act(async () => dialogButton('Cancel')!.click());
    await settle();
    expect(changes()).toHaveLength(0);
  });

  it('disables after the question, then asks for the list again', async () => {
    replies['PATCH /api/users/u2'] = { status: 200, body: {} };
    await open('/admin');
    const before = calls.filter((c) => c.path === '/api/users').length;
    await act(async () => rowButton('reviewer@example.com', 'Disable')!.click());
    await act(async () => dialogButton('Disable')!.click());
    await settle();
    expect(changes().map((c) => [c.path, c.body])).toEqual([['/api/users/u2', { disabled: true }]]);
    expect(calls.filter((c) => c.path === '/api/users').length).toBeGreaterThan(before);
  });

  it('enables with one click', async () => {
    replies['PATCH /api/users/u3'] = { status: 200, body: {} };
    await open('/admin');
    await act(async () => rowButton('gone@example.com', 'Enable')!.click());
    await settle();
    expect(changes().map((c) => c.body)).toEqual([{ disabled: false }]);
  });

  it('asks before a role change, and says when it takes effect', async () => {
    replies['PATCH /api/users/u2'] = { status: 200, body: {} };
    await open('/admin');
    await act(async () => rowButton('reviewer@example.com', 'Make admin')!.click());
    await settle();
    expect(document.body.textContent).toContain(
      'They see the Admin page the next time they open the site.',
    );
    expect(document.activeElement).toBe(dialogButton('Cancel'));
    await act(async () => dialogButton('Make admin')!.click());
    await settle();
    expect(changes().map((c) => c.body)).toEqual([{ role: 'admin' }]);
  });

  it('shows a refusal as the server words it', async () => {
    replies['PATCH /api/users/u3'] = {
      status: 409,
      body: { message: 'There must always be at least one active admin.' },
    };
    await open('/admin');
    await act(async () => rowButton('gone@example.com', 'Enable')!.click());
    await settle();
    expect(text()).toContain('There must always be at least one active admin.');
  });

  it('puts your own account first', async () => {
    replies['GET /api/users'] = {
      status: 200,
      body: [account('u9', 'aaron@example.com', 'admin'), ...USERS],
    };
    await open('/admin');
    const emails = [...container.querySelectorAll('tbody tr')].map(
      (r) => r.querySelector('td')?.textContent,
    );
    expect(emails).toEqual([
      ADMIN.email,
      'aaron@example.com',
      'gone@example.com',
      'reviewer@example.com',
    ]);
  });

  it('when the list is refused (no longer an admin), asks who is logged in again', async () => {
    let asked = 0;
    replies['GET /api/auth/me'] = () => ({ status: 200, body: asked++ ? REVIEWER : ADMIN });
    replies['GET /api/users'] = { status: 403, body: { message: 'Only an admin can do this.' } };
    await open('/admin');
    await settle();
    expect(asked).toBeGreaterThan(1);
    expect(button('Admin')).toBeUndefined();
    expect(text()).toContain('Only an admin can open this page.');
  });

  it('after a 403 (no longer an admin), asks who is logged in again', async () => {
    replies['PATCH /api/users/u3'] = {
      status: 403,
      body: { message: 'Only an admin can do this.' },
    };
    await open('/admin');
    const before = calls.filter((c) => c.path === '/api/auth/me').length;
    await act(async () => rowButton('gone@example.com', 'Enable')!.click());
    await settle();
    expect(calls.filter((c) => c.path === '/api/auth/me').length).toBeGreaterThan(before);
  });
});

describe('inviting', () => {
  it('sends the email and role with the CSRF header, and shows the link once', async () => {
    document.cookie = 'tally_csrf=abc';
    replies['POST /api/users/invite'] = {
      status: 201,
      body: { inviteUrl: LINK, expiresAt: '2026-11-29T22:30:00.000Z' },
    };
    await open('/admin');
    await type('Email', ' New@Example.com ');
    await chooseRole('Admin');
    await click('Invite');
    expect(invites().map((c) => c.body)).toEqual([{ email: 'new@example.com', role: 'admin' }]);
    expect(invites()[0]!.headers.get('x-csrf-token')).toBe('abc');
    // 22:30 UTC on the 29th is already the 30th in Israel.
    expect(text()).toContain(
      'Send this link to new@example.com. It works once, until 30/11/26. It will not be shown again. Any earlier link for this email no longer works.',
    );
    const warning = [...container.querySelectorAll('strong')].map((s) => s.textContent);
    expect(warning).toContain(
      'Do not open this link yourself: whoever opens it first gets the account.',
    );
    expect(linkField()?.value).toBe(LINK);
    expect(linkField()?.readOnly).toBe(true);
    // Not kept once the page is left.
    const cached = () =>
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((m) => m.state),
      );
    expect(cached()).toContain('secret-token');
    await act(async () => router.navigate('/'));
    await settle();
    expect(cached()).not.toContain('secret-token');
  });

  it('disables Invite and the account buttons while an invite is being sent', async () => {
    const fake = fetch;
    let answer!: () => void;
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) =>
      path === '/api/users/invite'
        ? new Promise<Response>((r) => {
            answer = () => r(new Response(JSON.stringify({ message: 'No.' }), { status: 409 }));
          })
        : fake(path, init),
    );
    await open('/admin');
    await type('Email', 'new@example.com');
    await click('Invite');
    const disabled = (b?: HTMLElement) => (b as HTMLButtonElement | undefined)?.disabled;
    expect(disabled(button('Invite'))).toBe(true);
    expect(disabled(rowButton('reviewer@example.com', 'Disable'))).toBe(true);
    expect(disabled(rowButton('gone@example.com', 'Enable'))).toBe(true);
    await act(async () => answer());
    await settle();
    expect(disabled(button('Invite'))).toBe(false);
    expect(disabled(rowButton('gone@example.com', 'Enable'))).toBe(false);
  });

  it('copies the link, and says so; or says to copy it by hand', async () => {
    replies['POST /api/users/invite'] = {
      status: 201,
      body: { inviteUrl: LINK, expiresAt: '2026-11-29T10:00:00.000Z' },
    };
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await open('/admin');
    await type('Email', 'new@example.com');
    await click('Invite');
    await click('Copy');
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(text()).toContain('Copied.');
    writeText.mockRejectedValueOnce(new Error('denied'));
    await click('Copy');
    expect(text()).toContain('Could not copy. Select the link and copy it yourself.');
  });

  it('refuses a bad email before sending anything', async () => {
    await open('/admin');
    await type('Email', 'not an email');
    await click('Invite');
    expect(invites()).toHaveLength(0);
    expect(text()).toContain('That is not a valid email address.');
  });

  it('shows the server refusal as it is worded, and no link', async () => {
    const taken =
      'This email already has an account. If it is disabled, enable it in the list above.';
    replies['POST /api/users/invite'] = { status: 409, body: { message: taken } };
    await open('/admin');
    await type('Email', 'reviewer@example.com');
    await click('Invite');
    expect(text()).toContain(taken);
    expect(linkField()).toBeUndefined();
  });
});
