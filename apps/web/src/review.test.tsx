// T2.3: the review screen against a fake API (no network). Names are invented.
import { FLAG_CODES } from '@tally/shared';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TicketDetail, TicketFlag } from './api.ts';
import { reason } from './review/flags.tsx';
import { boxStyle } from './review/ImageViewer.tsx';
import { prefill } from './review/TicketForm.tsx';
import {
  button,
  calls,
  choose,
  click,
  container,
  dialogButton,
  open,
  replies,
  REVIEWER,
  settle,
  text,
  type,
  url,
  useFakeApi,
} from './testing.tsx';

useFakeApi();

const flag = (code: string, field: string | null = null, detail = {}, more = {}) =>
  ({
    id: `${code}-${field}`,
    code,
    field,
    detail,
    relatedTicketId: null,
    resolvedAt: null,
    ...more,
  }) as TicketFlag;

const ticket = (over: Partial<TicketDetail> = {}): TicketDetail => ({
  id: 't1',
  monthId: 'm1',
  pageIndex: 0,
  status: 'needs_review',
  version: 3,
  firstName: 'זיו',
  workerName: null,
  workplaceRaw: 'שופרסל',
  workplaceGroupId: 'g1',
  shiftDate: '2026-11-12T00:00:00.000Z',
  startMinutes: 22 * 60,
  endMinutes: 6 * 60,
  totalMinutes: 8 * 60 + 30,
  totalFromMath: false,
  createdAt: '2026-11-13T10:00:00.000Z',
  imageUrl: 'https://storage.example/page.jpg',
  suggestions: {},
  flags: [],
  related: [],
  ...over,
});

/** Read twice, disagreeing about the total; the end time unclear, with a guess. */
const DISPUTED = ticket({
  suggestions: { endTime: '06:00' },
  flags: [
    flag('FIELD_UNREADABLE', 'endTime', { passA: '06:00', passB: null }),
    flag('PASS_DISAGREEMENT', 'totalWorked', { passA: '08:30', passB: '06:30' }),
    flag('CORRECTION_MARKS', 'totalWorked'),
    flag('TIME_MATH_MISMATCH', 'totalWorked', { computed: 480, total: 510 }),
    flag('NAME_NOT_CONFIRMED', 'firstName'),
  ],
});

/** The queue: the tickets waiting, by status. */
function queue(review: { id: string; flags?: object[] }[], manual: { id: string }[] = []) {
  const page = (ts: { id: string; flags?: object[] }[]) => ({
    status: 200,
    body: { total: ts.length, tickets: ts.map((t) => ({ flags: [], ...t })) },
  });
  replies['GET /api/tickets?status=needs_review'] = page(review);
  replies['GET /api/tickets?status=needs_review&page=1'] = page(review);
  replies['GET /api/tickets?status=needs_manual_entry'] = page(manual);
  replies['GET /api/tickets?status=needs_manual_entry&page=1'] = page(manual);
  replies['GET /api/tickets?status=needs_review&flag=WORKPLACE_SIMILAR'] = page(
    review.filter((t) => t.flags?.length),
  );
}

const MONTH = {
  id: 'm1',
  year: 2026,
  month: 11,
  status: 'open',
  tickets: { processing: 0, verified: 1, needs_review: 1, needs_manual_entry: 0, excluded: 0 },
  workplaces: [
    {
      groupId: 'g1',
      name: 'שופרסל',
      rows: [{ name: 'Zohar', tickets: [] }],
      unnamed: [],
    },
  ],
};

beforeEach(() => {
  replies['GET /api/auth/me'] = { status: 200, body: REVIEWER };
  replies['GET /api/progress'] = { status: 200, body: [] };
  replies['GET /api/months/m1'] = { status: 200, body: MONTH };
  replies['GET /api/lists/name'] = {
    status: 200,
    body: [
      { name: 'Avi', spellings: [] },
      { name: 'Zohar', spellings: [] },
    ],
  };
});

const focused = () => document.activeElement as HTMLElement;
async function press(key: string, opts: KeyboardEventInit = {}) {
  await act(async () => {
    focused().dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }),
    );
  });
  await settle();
}
const input = (label: string) =>
  [...container.querySelectorAll('input')].find((i) =>
    i.labels?.[0]?.textContent?.startsWith(label),
  )!;
const put = () => calls.filter((c) => c.method === 'PUT');

async function review(t: TicketDetail) {
  queue([{ id: t.id }]);
  replies[`GET /api/tickets/${t.id}`] = { status: 200, body: t };
  await open(`/review/${t.id}`);
}

describe('the reasons', () => {
  it('says each flag in plain words, with its values', () => {
    const html = (f: TicketFlag, t?: TicketDetail) =>
      renderToStaticMarkup(<>{reason(f, t)}</>).replace(/<\/?bdi>/g, '');
    expect(html(DISPUTED.flags[1]!)).toBe('The two readings disagree: 08:30 and 06:30');
    expect(html(DISPUTED.flags[3]!)).toBe('Start and end give 8:00, but total says 8:30');
    expect(html(flag('FIELD_UNREADABLE', 'endTime', { passA: null, suggestionB: '06:00' }))).toBe(
      'Could not read the end time. It was read as 06:00',
    );
    expect(html(flag('HOURS_OUT_OF_RANGE', 'totalWorked', { minutes: 1140, minHours: 2 }))).toBe(
      'Total of 19:00 is unusually long',
    );
    expect(
      html(flag('MATCH_AMBIGUOUS', 'workplace', { match: 'בית נוי', alsoFits: ['בית נוף'] })),
    ).toBe('Is this בית נוי or בית נוף?');
    expect(html(flag('MONTH_CLOSED', 'date', { year: 2026, month: 11 }))).toContain(
      'November 2026 is already closed',
    );
    // Values the reader gave are kept apart, so Hebrew reads right to left.
    expect(renderToStaticMarkup(<>{reason(DISPUTED.flags[1]!)}</>)).toContain('<bdi>08:30</bdi>');
  });

  it('has words for every flag, even without details', () => {
    for (const code of FLAG_CODES) {
      expect(
        renderToStaticMarkup(<MemoryRouter>{reason(flag(code))}</MemoryRouter>).length,
      ).toBeGreaterThan(10);
    }
  });
});

describe('what the form starts with', () => {
  it('fills in a guess only while its box is in doubt, and leaves a disputed box empty', () => {
    const v = prefill(DISPUTED);
    expect(v.endTime).toBe('06:00'); // the reader's guess (D24)
    expect(v.totalWorked).toBe(''); // two readings, no agreed guess: none is picked
    expect(v.startTime).toBe('22:00');
    expect(v.date).toBe('12/11/26');
    expect(v.firstName).toBe('זיו');

    // Once the doubt is settled, the saved value counts, not the old guess.
    const settled = { ...DISPUTED, flags: [], endMinutes: 7 * 60 };
    expect(prefill(settled).endTime).toBe('07:00');
  });

  it('shows a time that does not exist as written, so it can be corrected', () => {
    const t = ticket({
      startMinutes: null,
      flags: [flag('TIME_INVALID', 'startTime', { value: '25:70' })],
    });
    expect(prefill(t).startTime).toBe('25:70');
  });
});

describe('reviewing a ticket with the keyboard', () => {
  it('starts on the first flagged box, and Tab moves between the flagged ones', async () => {
    await review(DISPUTED);
    expect(focused().id).toBe('f-endTime');
    await press('Tab');
    expect(focused().id).toBe('f-totalWorked');
    // The total is empty, not as stored: "the paper really says this" cannot apply.
    expect(
      container.querySelector<HTMLInputElement>('#a-TIME_MATH_MISMATCH-totalWorked')!.disabled,
    ).toBe(true);
    await press('Tab');
    expect(focused().id).toBe('f-workerName');
    await press('Tab');
    expect(focused().textContent).toBe('Correct, next');
    // Back again with Shift+Tab, from a flagged box.
    document.getElementById('f-workerName')!.focus();
    await press('Tab', { shiftKey: true });
    expect(focused().id).toBe('f-totalWorked');
  });

  it('Enter walks to the next flagged box, then saves once each was visited', async () => {
    await review(DISPUTED);
    replies['PUT /api/tickets/t1'] = { status: 200, body: { ...DISPUTED, status: 'verified' } };
    await press('Enter');
    expect(focused().id).toBe('f-totalWorked');
    await type('Total', '08:00');
    await press('Enter');
    expect(focused().id).toBe('f-workerName');
    await type('Name in English', 'Ziv');
    await press('Enter', { repeat: true }); // a held key does nothing
    expect(put()).toHaveLength(0);
    queue([]);
    await press('Enter');
    expect(put()).toHaveLength(1);
    expect(put()[0]!.body).toEqual({
      version: 3,
      values: {
        firstName: 'זיו',
        workplace: 'שופרסל',
        date: '12/11/26',
        startTime: '22:00',
        endTime: '06:00',
        totalWorked: '08:00',
      },
      workerName: 'Ziv',
      accept: [],
    });
    // Verified: on to the next ticket, and the queue is empty.
    expect(url()).toBe('/review');
    expect(text()).toContain('Nothing left to check.');
  });

  it('saves with Enter when only one box is flagged', async () => {
    const t = ticket({ workerName: 'Ziv', flags: [flag('CORRECTION_MARKS', 'startTime')] });
    await review(t);
    replies['PUT /api/tickets/t1'] = { status: 200, body: { ...t, status: 'verified' } };
    queue([]);
    expect(focused().id).toBe('f-startTime');
    await press('Enter');
    expect(put()).toHaveLength(1);
  });

  it('never fills in a name for the Excel that is not in English letters', async () => {
    await review(ticket({ workerName: 'זיו', flags: [flag('CORRECTION_MARKS', 'startTime')] }));
    expect(input('Name in English').value).toBe('');
  });

  it('sends a confirmation as written only for values left as they were', async () => {
    const t = ticket({
      workerName: 'Ziv',
      flags: [flag('HOURS_OUT_OF_RANGE', 'totalWorked', { minutes: 1140, minHours: 2 })],
      totalMinutes: 19 * 60,
      endMinutes: 17 * 60,
      startMinutes: 22 * 60,
    });
    await review(t);
    replies['PUT /api/tickets/t1'] = { status: 200, body: { ...t, status: 'verified' } };
    expect(focused().id).toBe('f-totalWorked');
    await press('Tab');
    expect(focused().id).toBe('a-HOURS_OUT_OF_RANGE-totalWorked');
    await act(async () => focused().click());
    await press('Enter');
    expect(put()[0]!.body).toMatchObject({ accept: ['HOURS_OUT_OF_RANGE'], workerName: 'Ziv' });
  });

  it('asks for the English name again when the first name is changed', async () => {
    await review(ticket({ workerName: 'Ziv', flags: [flag('PASS_DISAGREEMENT', 'firstName')] }));
    replies['PUT /api/tickets/t1'] = { status: 200, body: ticket({ status: 'verified' }) };
    await type('First name', 'זיוה');
    expect(input('Name in English').value).toBe('');
    await click('Correct, next');
    expect(put()[0]!.body).toMatchObject({ workerName: null });
  });

  it('refuses a name with Hebrew letters before saving', async () => {
    await review(ticket({ flags: [flag('NAME_NOT_CONFIRMED', 'firstName')] }));
    await type('Name in English', 'זיו');
    await click('Correct, next');
    expect(put()).toHaveLength(0);
    expect(text()).toContain('Type the name in English letters.');
  });

  it('stays on a ticket that still needs something, and says what', async () => {
    await review(DISPUTED);
    const after = ticket({
      version: 4,
      workerName: 'Ziv',
      flags: [flag('HOURS_OUT_OF_RANGE', 'totalWorked', { minutes: 60, minHours: 2 })],
    });
    replies['PUT /api/tickets/t1'] = { status: 200, body: after };
    await click('Correct, next');
    expect(url()).toBe('/review/t1');
    expect(text()).toContain('Saved. This ticket still needs: Total of 1:00 is unusually short.');
    expect(input('Name in English').value).toBe('Ziv');
    expect(focused().id).toBe('f-totalWorked');
  });

  it('shows a stale save as the server says, with Reload', async () => {
    await review(DISPUTED);
    replies['PUT /api/tickets/t1'] = {
      status: 409,
      body: { message: 'Someone else changed this ticket. Reload it.' },
    };
    await click('Correct, next');
    expect(text()).toContain('Someone else changed this ticket. Reload it.');
    replies['GET /api/tickets/t1'] = { status: 200, body: { ...DISPUTED, version: 5 } };
    await click('Reload');
    expect(text()).not.toContain('Someone else changed');
    await click('Correct, next');
    expect(put()[1]!.body).toMatchObject({ version: 5 });
  });

  it('types in a ticket that could not be read, walking every box', async () => {
    const broken = ticket({
      id: 't9',
      status: 'needs_manual_entry',
      monthId: null,
      firstName: null,
      workplaceRaw: null,
      workplaceGroupId: null,
      shiftDate: null,
      startMinutes: null,
      endMinutes: null,
      totalMinutes: null,
      flags: [flag('EXTRACTION_ERROR')],
    });
    await review(broken);
    expect(text()).toContain('Could not read this ticket. Please type it in.');
    expect(input('First name').value).toBe('');
    expect(focused().id).toBe('f-firstName');
    await press('Enter');
    expect(focused().id).toBe('f-workplace');
  });
});

describe('the rest of the screen', () => {
  it('outlines the flagged boxes on the scan, and the focused one strongly', async () => {
    await review(DISPUTED);
    const box = (k: string) => container.querySelector<HTMLElement>(`[data-box="${k}"]`);
    expect(box('endTime')!.style.outline).toContain('3px'); // focused
    expect(box('totalWorked')!.style.outline).toContain('2px'); // flagged
    expect(box('workplace')).toBeNull();
    expect(box('endTime')!.style.left).toBe(boxStyle('endTime').left);
    expect(container.querySelector('img')!.getAttribute('src')).toBe('/api/tickets/t1/slip');
    await click('Show the whole scan');
    expect(container.querySelector('img')!.getAttribute('src')).toBe(DISPUTED.imageUrl);
    expect(box('endTime')).toBeNull();
  });

  it('offers the names used at this workplace this month first, then the names list', async () => {
    await review(DISPUTED);
    document.getElementById('f-workerName')!.focus();
    await press('ArrowDown');
    const listed = document.querySelector('[role="listbox"]')!.textContent;
    expect(listed).toBe('Used at this workplace this monthZoharOn the names listAvi');
  });

  it('asks about a possible duplicate with three answers, none chosen', async () => {
    const other = ticket({ id: 't0', createdAt: '2026-11-12T09:00:00.000Z', workerName: 'Ziv' });
    const t = ticket({
      workerName: 'Ziv',
      flags: [flag('POSSIBLE_DUPLICATE', null, {}, { id: 'q1', relatedTicketId: 't0' })],
      related: [other],
    });
    await review(t);
    expect(focused().id).toBe('dup-q1');
    expect(text()).toContain('Scanned first');
    expect(text()).toContain('Scanned later (this ticket)');
    for (const label of ['Replace the old one', 'Keep both', 'Ignore the new one']) {
      expect(button(label)!.className).not.toContain('contained');
    }
    replies['POST /api/flags/q1/resolve'] = { status: 204 };
    replies['GET /api/tickets/t1'] = { status: 200, body: { ...t, status: 'verified' } };
    queue([]);
    await click('Keep both');
    expect(calls.find((c) => c.path === '/api/flags/q1/resolve')!.body).toEqual({
      decision: 'keep_both',
    });
    expect(text()).toContain('Nothing left to check.');
  });

  it('after a duplicate answer that leaves work, puts the focus on the flagged box', async () => {
    const other = ticket({ id: 't0', createdAt: '2026-11-12T09:00:00.000Z', workerName: 'Ziv' });
    const math = flag('TIME_MATH_MISMATCH', 'totalWorked', { computed: 480, total: 510 });
    const dup = flag('POSSIBLE_DUPLICATE', null, {}, { id: 'q1', relatedTicketId: 't0' });
    const t = ticket({ workerName: 'Ziv', flags: [dup, math], related: [other] });
    await review(t);
    expect(focused().id).toBe('dup-q1');
    replies['POST /api/flags/q1/resolve'] = { status: 204 };
    replies['GET /api/tickets/t1'] = {
      status: 200,
      body: { ...t, flags: [{ ...dup, resolvedAt: '2026-11-22T10:00:00.000Z' }, math] },
    };
    await click('Keep both');
    expect(url()).toBe('/review/t1');
    expect(focused().id).toBe('f-totalWorked');
    const said = [...container.querySelectorAll('[role="status"]')].map((s) => s.textContent);
    expect(said).toContain('Answered.');
  });

  it('sends one save for two quick clicks', async () => {
    await review(DISPUTED);
    replies['PUT /api/tickets/t1'] = { status: 200, body: { ...DISPUTED, version: 4 } };
    await act(async () => {
      button('Correct, next')!.click();
      button('Correct, next')!.click();
    });
    await settle();
    expect(put()).toHaveLength(1);
  });

  it('asks for a fresh scan link once when the whole scan does not load', async () => {
    await review(DISPUTED);
    await click('Show the whole scan');
    const gets = () => calls.filter((c) => c.path === '/api/tickets/t1').length;
    const before = gets();
    const fail = async () => {
      await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')));
      await settle();
    };
    await fail();
    expect(gets()).toBe(before + 1);
    expect(text()).not.toContain('The scan could not be loaded.');
    await fail();
    expect(gets()).toBe(before + 1);
    expect(text()).toContain('The scan could not be loaded.');
  });

  it('removes a ticket only after asking, with Cancel first', async () => {
    await review(DISPUTED);
    await choose('More', 'Remove ticket');
    expect(focused().textContent).toBe('Cancel');
    expect(document.body.textContent).toContain('It leaves the Excel and the workplace PDF.');
    await act(async () => dialogButton('Cancel')!.click());
    await settle();
    expect(calls.some((c) => c.path.endsWith('/exclude'))).toBe(false);
    replies['POST /api/tickets/t1/exclude'] = { status: 204 };
    await choose('More', 'Remove ticket');
    queue([]);
    await act(async () => dialogButton('Remove')!.click());
    await settle();
    expect(calls.find((c) => c.path === '/api/tickets/t1/exclude')!.body).toEqual({ version: 3 });
    expect(url()).toBe('/review');
  });

  it('asks before reading a ticket again, then goes on', async () => {
    await review(DISPUTED);
    replies['POST /api/tickets/t1/reprocess'] = { status: 204 };
    await choose('More', 'Read again');
    expect(document.body.textContent).toContain('Reading it costs money.');
    queue([]);
    await act(async () => dialogButton('Read again')!.click());
    await settle();
    expect(calls.some((c) => c.path === '/api/tickets/t1/reprocess')).toBe(true);
    expect(url()).toBe('/review');
  });
});

describe('the queue', () => {
  it('goes to the oldest ticket, skips the skipped and those waiting for a workplace answer', async () => {
    const similar = { code: 'WORKPLACE_SIMILAR', field: 'workplace' };
    queue([{ id: 'a', flags: [similar] }, { id: 'b' }], [{ id: 'c' }]);
    // A ticket with another flag as well is reviewed now: it does not wait.
    replies['GET /api/tickets?status=needs_review&flag=WORKPLACE_SIMILAR'] = {
      status: 200,
      body: {
        total: 2,
        tickets: [
          { id: 'a', flags: [similar] },
          { id: 'x', flags: [similar, { code: 'FIELD_EMPTY', field: 'date' }] },
        ],
      },
    };
    replies['GET /api/tickets/b'] = { status: 200, body: ticket({ id: 'b' }) };
    replies['GET /api/tickets/c'] = { status: 200, body: ticket({ id: 'c' }) };
    await open('/review');
    expect(url()).toBe('/review/b');
    expect(text()).toContain('3 tickets left; 1 of them wait for a workplace answer');
    expect(button('Workplaces page')?.getAttribute('href')).toBe('/workplaces');
    await choose('More', 'Skip for now');
    expect(url()).toBe('/review/c');
    await choose('More', 'Skip for now');
    expect(text()).toContain('Nothing left to check.');
    expect(text()).toContain('You skipped 2 tickets.');
    await click('Check the skipped tickets');
    expect(url()).toBe('/review/b');
  });

  it('keeps the month and the chosen flag from ticket to ticket', async () => {
    replies['GET /api/tickets?month=none&status=needs_review&flag=DATE_INVALID&page=1'] = {
      status: 200,
      body: { total: 0, tickets: [] },
    };
    replies['GET /api/tickets?month=none&status=needs_manual_entry&flag=DATE_INVALID&page=1'] = {
      status: 200,
      body: { total: 0, tickets: [] },
    };
    await open('/review?month=none&flag=DATE_INVALID');
    expect(text()).toContain('Nothing left to check.');
    expect(calls.map((c) => c.path)).toContain(
      '/api/tickets?month=none&status=needs_review&flag=DATE_INVALID',
    );
  });
});
