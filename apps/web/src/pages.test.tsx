// T2.2: Home, the month page, the upload page and live progress, against a fake API and a fake
// upload to storage (no network).
import { MAX_UPLOAD_BYTES, NOT_ARRIVED, TOO_LARGE } from '@tally/shared';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  button,
  calls,
  click,
  container,
  dialogButton,
  open,
  replies,
  REVIEWER,
  settle,
  text,
  url,
  useFakeApi,
} from './testing.tsx';

useFakeApi();

const counts = (c: Partial<Record<string, number>> = {}) => ({
  processing: 0,
  verified: 0,
  needs_review: 0,
  needs_manual_entry: 0,
  excluded: 0,
  ...c,
});
const NOVEMBER = {
  id: 'm-nov',
  year: 2026,
  month: 11,
  status: 'open',
  tickets: counts({ verified: 628, needs_review: 10, needs_manual_entry: 2, excluded: 5 }),
};
const OCTOBER = { id: 'm-oct', year: 2026, month: 10, status: 'open', tickets: counts() };
const SEPTEMBER = { ...OCTOBER, id: 'm-sep', month: 9, status: 'closed' };

const upload = (over: object = {}) => ({
  id: 'up1',
  filename: 'scan3.pdf',
  createdAt: new Date().toISOString(),
  activeAt: new Date().toISOString(),
  pages: 40,
  splitting: false,
  failedPages: [],
  tickets: counts({ processing: 28, verified: 12 }),
  ...over,
});

beforeEach(() => {
  replies['GET /api/auth/me'] = { status: 200, body: REVIEWER };
  replies['GET /api/progress'] = { status: 200, body: [] };
  replies['GET /api/lists/workplace'] = { status: 200, body: [] };
  replies['GET /api/lists/name'] = { status: 200, body: [] };
});

describe('Home', () => {
  it('shows the open months with their counts and the tickets waiting for a date', async () => {
    replies['GET /api/months'] = { status: 200, body: [NOVEMBER, OCTOBER, SEPTEMBER] };
    replies['GET /api/tickets?month=none&status=needs_review'] = {
      status: 200,
      body: { total: 3, tickets: [] },
    };
    replies['GET /api/tickets?month=none&status=needs_manual_entry'] = {
      status: 200,
      body: { total: 1, tickets: [] },
    };
    await open('/');
    expect(text()).toContain('November 2026: 640 tickets, 12 need review');
    expect(text()).toContain('October 2026: 0 tickets');
    expect(text()).not.toContain('September');
    expect(text()).toContain('4 tickets wait for a date');
    expect(button('4 tickets wait for a date.')?.getAttribute('href')).toBe('/review?month=none');
    expect(button('Review next')?.getAttribute('href')).toBe('/review');
    expect(button('November 2026')?.getAttribute('href')).toBe('/months/m-nov');
    await click('Upload');
    expect(url()).toBe('/upload');
  });

  it('says so when the tickets waiting for a date cannot be counted', async () => {
    replies['GET /api/months'] = { status: 200, body: [] };
    replies['GET /api/tickets?month=none&status=needs_review'] = { status: 400 };
    await open('/');
    expect(text()).toContain('Something went wrong on our side. Try again.');
    expect(button('Try again')).toBeDefined();
  });

  it('says so when there is no month yet', async () => {
    replies['GET /api/months'] = { status: 200, body: [] };
    await open('/');
    expect(text()).toContain('No months yet.');
    expect(text()).toContain(
      'Before the first upload, set up the lists that help reading on the Workplaces page.',
    );
    expect(button('Workplaces page')?.getAttribute('href')).toBe('/workplaces');
  });
});

describe('the month page', () => {
  const ticket = (id: string, over: object = {}) => ({
    id,
    version: 2,
    workerName: 'Yael',
    shiftDate: '2026-11-10T00:00:00.000Z',
    totalMinutes: 510,
    status: 'verified',
    ...over,
  });

  it('lists the tickets by workplace and row, with unsorted tickets counted', async () => {
    replies['GET /api/months/m-nov'] = {
      status: 200,
      body: {
        ...NOVEMBER,
        tickets: counts({ verified: 3, needs_review: 2, excluded: 1 }),
        workplaces: [
          {
            groupId: 'g1',
            name: 'דולב',
            rows: [
              {
                name: 'Yael',
                tickets: [ticket('t1'), ticket('t2', { shiftDate: '2026-11-11T00:00:00.000Z' })],
              },
            ],
            unnamed: [
              ticket('t3', { workerName: null, totalMinutes: null, status: 'needs_review' }),
            ],
          },
          { groupId: 'g2', name: 'Empty place', rows: [], unnamed: [] },
        ],
        questions: [],
      },
    };
    await open('/months/m-nov');
    expect(text()).toContain('November 2026');
    expect(text()).toContain('5 tickets');
    expect(text()).toContain('2 tickets still need review and are left out of downloads');
    expect(text()).toContain('1 ticket removed');
    expect(text()).toContain('2 tickets are not sorted into a workplace yet');
    const place = [...container.querySelectorAll('h2')].find((h) => h.textContent === 'דולב')!;
    expect(place.getAttribute('dir')).toBe('auto');
    expect(text()).not.toContain('Empty place');
    expect(text()).toContain('10/11/26');
    expect(text()).toContain('11/11/26');
    expect(text()).toContain('8:30');
    expect(text()).toContain('Name not confirmed yet');
    expect(text()).toContain('—');
    expect(text()).toContain('Needs review');
  });

  describe('Download Excel', () => {
    const saved: string[] = [];
    beforeEach(() => {
      saved.length = 0;
      URL.createObjectURL = vi.fn(() => 'blob:excel');
      URL.revokeObjectURL = vi.fn();
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        saved.push(`${this.download} ${this.getAttribute('href')}`);
      });
      replies['GET /api/months/m-nov'] = { status: 200, body: SMALL };
    });
    afterEach(() => vi.restoreAllMocks());

    it("saves the month's file", async () => {
      replies['GET /api/months/m-nov/excel'] = { status: 200, body: 'xlsx bytes' };
      await open('/months/m-nov');
      await click('Download Excel');
      expect(saved).toEqual(['hours-2026-11.xlsx blob:excel']);
      expect(text()).not.toContain('went wrong');
    });

    it('says why when the file cannot be made, on the page', async () => {
      replies['GET /api/months/m-nov/excel'] = {
        status: 409,
        body: { message: 'Some tickets are still being sorted. Try again in a minute.' },
      };
      await open('/months/m-nov');
      await click('Download Excel');
      expect(saved).toEqual([]);
      expect(text()).toContain('Some tickets are still being sorted. Try again in a minute.');
      expect(button('Download Excel')?.hasAttribute('disabled')).toBe(false);
    });
  });

  const SMALL = {
    ...NOVEMBER,
    tickets: counts({ verified: 1, needs_review: 1 }),
    workplaces: [
      {
        groupId: 'g1',
        name: 'דולב',
        rows: [{ name: 'Yael', tickets: [ticket('t1')] }],
        unnamed: [],
      },
      {
        groupId: 'g2',
        name: 'Golan Farm',
        rows: [{ name: 'Kwame', tickets: [ticket('t2', { status: 'needs_review' })] }],
        unnamed: [],
      },
    ],
    questions: [],
  };

  it('searches the tickets by name, workplace or date, and opens one for review', async () => {
    replies['GET /api/months/m-nov'] = { status: 200, body: SMALL };
    await open('/months/m-nov');
    expect(button('Review next')?.getAttribute('href')).toBe('/review?month=m-nov');
    const search = async (value: string) => {
      const input = container.querySelector('input')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    await search('kwa');
    expect(text()).toContain('Kwame');
    expect(text()).not.toContain('Yael');
    await search('דולב');
    expect(text()).toContain('Yael');
    expect(text()).not.toContain('Kwame');
    await search('nobody');
    expect(text()).toContain('No ticket matches.');
    await search('');
    expect(container.querySelector('[aria-label="Remove Yael, 10/11/26"]')).not.toBeNull();
    await click('Open');
    expect(url()).toBe('/review/t1?month=m-nov');
  });

  it('removes a ticket after asking, naming the version shown', async () => {
    replies['GET /api/months/m-nov'] = { status: 200, body: SMALL };
    replies['POST /api/tickets/t1/exclude'] = {
      status: 409,
      body: { message: 'Someone else changed this ticket. Reload it.' },
    };
    await open('/months/m-nov');
    await click('Remove');
    expect(document.body.textContent).toContain('Remove this ticket?');
    await act(async () => dialogButton('Remove')!.click());
    await settle();
    expect(calls.find((c) => c.path === '/api/tickets/t1/exclude')!.body).toEqual({ version: 2 });
    expect(text()).toContain('Someone else changed this ticket. Reload it.');
    expect(calls.filter((c) => c.path === '/api/months/m-nov').length).toBe(2);
  });

  it('shows the server message for a month that does not exist', async () => {
    replies['GET /api/months/nope'] = { status: 404, body: { message: 'There is no such month.' } };
    await open('/months/nope');
    expect(text()).toContain('There is no such month.');
  });
});

describe('live progress', () => {
  it('asks every 3 seconds while an upload is being read, and stops when it is done', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    replies['GET /api/months'] = { status: 200, body: [] };
    replies['GET /api/progress'] = { status: 200, body: [upload({ filename: 'סריקה.pdf' })] };
    await open('/');
    expect(text()).toContain('סריקה.pdf: reading: 12 of 40 pages done');
    const asked = () => calls.filter((c) => c.path === '/api/progress').length;
    expect(asked()).toBe(1);
    await act(async () => vi.advanceTimersByTime(3000));
    await settle();
    expect(asked()).toBe(2);

    replies['GET /api/progress'] = {
      status: 200,
      body: [upload({ tickets: counts({ verified: 38, needs_review: 2 }), failedPages: [4, 9] })],
    };
    await act(async () => vi.advanceTimersByTime(3000));
    await settle();
    expect(text()).toContain('1 upload fully read');
    expect(text()).toContain('2 pages could not be opened: scan them again');
    await act(async () => vi.advanceTimersByTime(9000));
    await settle();
    expect(asked()).toBe(3);
  });

  it('says when an upload is splitting, and when reading it stopped', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    replies['GET /api/months'] = { status: 200, body: [] };
    const old = new Date(Date.now() - 27 * 3600_000).toISOString();
    replies['GET /api/progress'] = {
      status: 200,
      body: [
        upload({ id: 'a', splitting: true, pages: 3 }),
        upload({ id: 'b', createdAt: old, activeAt: old }),
        // An old upload with a ticket sent to be read again is not stuck.
        upload({ id: 'c', filename: 'old.pdf', createdAt: old }),
      ],
    };
    await open('/');
    expect(text()).toContain('scan3.pdf: getting the pages ready to read…');
    expect(text()).toContain('Reading this upload stopped. Tell your admin.');
    expect(text()).toContain('old.pdf: reading: 12 of 40 pages done');

    replies['GET /api/progress'] = {
      status: 200,
      body: [upload({ id: 'b', createdAt: old, activeAt: old })],
    };
    await act(async () => vi.advanceTimersByTime(3000));
    await settle();
    await act(async () => vi.advanceTimersByTime(9000));
    await settle();
    expect(calls.filter((c) => c.path === '/api/progress').length).toBe(2);
  });
});

describe('live counts', () => {
  it('asks for the months every 3 seconds while reading, and for 2 minutes after', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    replies['GET /api/months'] = { status: 200, body: [NOVEMBER] };
    replies['GET /api/progress'] = { status: 200, body: [upload()] };
    await open('/');
    const asked = () => calls.filter((c) => c.path === '/api/months').length;
    const wait = async (ms: number) => {
      await act(async () => vi.advanceTimersByTime(ms));
      await settle();
    };
    expect(asked()).toBe(1);
    await wait(3000);
    expect(asked()).toBe(2);

    replies['GET /api/progress'] = {
      status: 200,
      body: [upload({ tickets: counts({ verified: 40 }) })],
    };
    await wait(3000);
    const idle = asked();
    await wait(60_000);
    expect(asked()).toBeGreaterThan(idle);
    await wait(63_000);
    const after = asked();
    await wait(9000);
    expect(asked()).toBe(after);
  });
});

/** Stands in for the browser's upload to storage; each test answers it by hand. */
class FakeXhr {
  static all: FakeXhr[] = [];
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onloadend: (() => void) | null = null;
  status = 0;
  url = '';
  body: unknown;
  aborted = false;
  open(method: string, url: string) {
    expect(method).toBe('PUT');
    this.url = url;
  }
  send(body: unknown) {
    this.body = body;
    FakeXhr.all.push(this);
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
    this.onloadend?.();
  }
  async respond(status: number) {
    this.status = status;
    await act(async () => {
      this.onload?.();
      this.onloadend?.();
    });
    await settle();
  }
  async fail() {
    await act(async () => {
      this.onerror?.();
      this.onloadend?.();
    });
    await settle();
  }
}

describe('the upload page', () => {
  let signed: number;
  beforeEach(() => {
    FakeXhr.all = [];
    signed = 0;
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    replies['POST /api/uploads/sign'] = () => {
      signed++;
      return { status: 200, body: [{ key: `uploads/k${signed}`, url: `https://s3/k${signed}` }] };
    };
    replies['POST /api/uploads/complete'] = (body) => {
      const { files } = body as { files: { key: string }[] };
      return {
        status: 200,
        body: [{ key: files[0]!.key, status: 'queued', uploadId: 'u', pages: 4 }],
      };
    };
  });

  const pdf = (name: string) => new File(['%PDF-'], name, { type: 'application/pdf' });

  async function choose(...files: File[]) {
    const input = container.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await settle();
  }

  const confirms = () => calls.filter((c) => c.path === '/api/uploads/complete');

  it('uploads each file on its own, 3 at a time, and shows how far each has come', async () => {
    await open('/upload');
    expect(text()).toContain('about 15 cents a ticket');
    expect(text()).toContain('about 30 cents a ticket, not yet measured');
    const now = [...container.querySelectorAll('input[type=radio]')].find((r) =>
      (r as HTMLInputElement).labels?.[0]?.textContent?.startsWith('Now'),
    ) as HTMLInputElement;
    await act(async () => now.click());
    await choose(pdf('a.pdf'), pdf('b.pdf'), pdf('c.pdf'), pdf('d.pdf'));
    expect(FakeXhr.all).toHaveLength(3);
    expect(FakeXhr.all[0]!.url).toBe('https://s3/k1');
    expect(calls.filter((c) => c.path === '/api/uploads/sign').map((c) => c.body)).toEqual([
      { count: 1 },
      { count: 1 },
      { count: 1 },
    ]);

    await act(async () =>
      FakeXhr.all[0]!.upload.onprogress!({
        lengthComputable: true,
        loaded: 1,
        total: 4,
      } as ProgressEvent),
    );
    expect(text()).toContain('Uploading: 25%');

    await FakeXhr.all[0]!.respond(200);
    expect(confirms()[0]!.body).toEqual({
      speed: 'now',
      files: [{ key: 'uploads/k1', name: 'a.pdf' }],
    });
    expect(text()).toContain('Uploaded: 4 pages, about $1.20');
    expect(FakeXhr.all).toHaveLength(4); // the fourth file starts when one finishes

    for (const x of FakeXhr.all.slice(1)) await x.respond(200);
    expect(confirms()).toHaveLength(4);
    expect(text()).toContain('16 tickets, about $4.80');
  });

  it('lets a failed file be tried again, from the step that failed', async () => {
    await open('/upload');
    await choose(pdf('a.pdf'), pdf('b.pdf'));
    await FakeXhr.all[0]!.fail();
    expect(text()).toContain(
      'Failed. The file did not upload. Check your connection and try again.',
    );

    replies['POST /api/uploads/complete'] = { status: 500 };
    await FakeXhr.all[1]!.respond(200);
    expect(confirms()[0]!.body).toEqual({
      speed: 'batch',
      files: [{ key: 'uploads/k2', name: 'b.pdf' }],
    });
    expect(text()).toContain('Something went wrong on our side. Try again.');

    replies['POST /api/uploads/complete'] = (body) => {
      const { files } = body as { files: { key: string }[] };
      return {
        status: 200,
        body: [{ key: files[0]!.key, status: 'queued', uploadId: 'u', pages: 1 }],
      };
    };
    const retries = () =>
      [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Retry');
    expect(retries()).toHaveLength(2);
    await act(async () => retries()[1]!.click()); // the confirm failed: same key again, no new upload
    await settle();
    expect(confirms().at(-1)!.body).toEqual({
      speed: 'batch',
      files: [{ key: 'uploads/k2', name: 'b.pdf' }],
    });
    expect(FakeXhr.all).toHaveLength(2);

    await act(async () => retries()[0]!.click()); // the upload failed: a new link
    await settle();
    expect(FakeXhr.all).toHaveLength(3);
    expect(FakeXhr.all[2]!.url).toBe('https://s3/k3');
  });

  it('uploads the file again when a retried confirm finds it never arrived', async () => {
    await open('/upload');
    replies['POST /api/uploads/complete'] = { status: 500 };
    await choose(pdf('a.pdf'));
    await FakeXhr.all[0]!.respond(200);
    replies['POST /api/uploads/complete'] = (body) => {
      const { files } = body as { files: { key: string }[] };
      return files[0]!.key === 'uploads/k1'
        ? { status: 200, body: [{ key: 'uploads/k1', status: 'rejected', message: NOT_ARRIVED }] }
        : {
            status: 200,
            body: [{ key: files[0]!.key, status: 'queued', uploadId: 'u', pages: 1 }],
          };
    };
    await click('Retry');
    expect(FakeXhr.all).toHaveLength(2);
    await FakeXhr.all[1]!.respond(200);
    expect(text()).toContain('Uploaded: 1 page');
  });

  it('shows duplicates and refused files with the server message and no Retry', async () => {
    await open('/upload');
    const big = pdf('huge.pdf');
    Object.defineProperty(big, 'size', { value: MAX_UPLOAD_BYTES + 1 });
    replies['POST /api/uploads/complete'] = (body) => {
      const { files } = body as { files: { key: string }[] };
      const key = files[0]!.key;
      return key === 'uploads/k1'
        ? {
            status: 200,
            body: [{ key, status: 'duplicate', message: 'This file was already uploaded.' }],
          }
        : {
            status: 200,
            body: [
              { key, status: 'rejected', message: 'Only PDF, JPEG and PNG files can be read.' },
            ],
          };
    };
    await choose(big, pdf('again.pdf'), new File(['x'], 'notes.txt'));
    expect(text()).toContain(TOO_LARGE);
    expect(FakeXhr.all).toHaveLength(2); // the big file is never sent
    await FakeXhr.all[0]!.respond(200);
    await FakeXhr.all[1]!.respond(200);
    expect(text()).toContain('This file was already uploaded.');
    expect(text()).toContain('Only PDF, JPEG and PNG files can be read.');
    expect(button('Retry')).toBeUndefined();
  });

  it('logs out when the session ended during an upload', async () => {
    await open('/upload');
    replies['POST /api/uploads/sign'] = { status: 401, body: { message: 'Please log in.' } };
    await choose(pdf('a.pdf'));
    expect(url()).toBe('/login?next=%2Fupload&expired=1');
  });

  const anywhere = (label: string) =>
    [...document.body.querySelectorAll('button, a')].find((b) => b.textContent === label) as
      HTMLElement | undefined;

  it('fails a file that storage refuses, and offers Retry', async () => {
    await open('/upload');
    await choose(pdf('a.pdf'));
    await FakeXhr.all[0]!.respond(403);
    expect(text()).toContain('Failed. The file did not upload.');
    expect(button('Retry')).toBeDefined();
    expect(confirms()).toHaveLength(0);
  });

  it('stops an upload with no progress for a minute, and offers Retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    await open('/upload');
    await choose(pdf('a.pdf'));
    await act(async () => vi.advanceTimersByTime(60_000));
    await settle();
    expect(FakeXhr.all[0]!.aborted).toBe(true);
    expect(button('Retry')).toBeDefined();
  });

  it('refuses a file that never arrives even when sent again', async () => {
    await open('/upload');
    replies['POST /api/uploads/complete'] = { status: 500 };
    await choose(pdf('a.pdf'));
    await FakeXhr.all[0]!.respond(200);
    replies['POST /api/uploads/complete'] = (body) => {
      const { files } = body as { files: { key: string }[] };
      return {
        status: 200,
        body: [{ key: files[0]!.key, status: 'rejected', message: NOT_ARRIVED }],
      };
    };
    await click('Retry');
    await FakeXhr.all[1]!.respond(200);
    expect(FakeXhr.all).toHaveLength(2);
    expect(text()).toContain(NOT_ARRIVED);
    expect(button('Retry')).toBeUndefined();
  });

  it('keeps the speed while files upload', async () => {
    await open('/upload');
    const radios = () => [...container.querySelectorAll('input[type=radio]')] as HTMLInputElement[];
    expect(radios().some((r) => r.disabled)).toBe(false);
    await choose(pdf('a.pdf'));
    expect(radios().every((r) => r.disabled)).toBe(true);
    await FakeXhr.all[0]!.respond(200);
    expect(radios().some((r) => r.disabled)).toBe(false);
  });

  it('asks before leaving while files upload, and stops them on leaving', async () => {
    replies['GET /api/months'] = { status: 200, body: [] };
    await open('/upload');
    await choose(pdf('a.pdf'));
    await click('Log out');
    expect(document.body.textContent).toContain('Files are still uploading.');
    await act(async () => anywhere('Stay')!.click());
    await settle();
    expect(url()).toBe('/upload');
    expect(calls.some((c) => c.path === '/api/auth/logout')).toBe(false);

    await click('Home');
    await act(async () => anywhere('Leave')!.click());
    await settle();
    expect(url()).toBe('/');
    expect(FakeXhr.all[0]!.aborted).toBe(true);
    expect(confirms()).toHaveLength(0);
  });

  it('leaves by itself when the files finish while it asks', async () => {
    replies['GET /api/months'] = { status: 200, body: [] };
    await open('/upload');
    await choose(pdf('a.pdf'));
    await click('Home');
    expect(document.body.textContent).toContain('Files are still uploading.');
    await FakeXhr.all[0]!.respond(200);
    expect(url()).toBe('/');
  });
});
