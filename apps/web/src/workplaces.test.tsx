// T2.4: the Workplaces page (same place or not) and the lists on the month page, against a fake
// API (no network). Names are invented.
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
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
  useFakeApi,
} from './testing.tsx';

useFakeApi();

const counts = { processing: 0, verified: 0, needs_review: 3, needs_manual_entry: 0, excluded: 0 };
const NOVEMBER = { id: 'm-nov', year: 2026, month: 11, status: 'open', tickets: counts };
const ticket = (id: string) => ({
  id,
  version: 1,
  workerName: 'Ziv',
  shiftDate: '2026-11-10T00:00:00.000Z',
  totalMinutes: 480,
  status: 'needs_review',
});
const QUESTION = {
  flagId: 'f1',
  groups: [
    { id: 'g1', name: 'שופרסל', spellings: ['שופרסל'], tickets: 2, ticketId: 't1' },
    { id: 'g2', name: 'שופר סל', spellings: ['שופר סל', 'שופר-סל'], tickets: 1, ticketId: 't3' },
  ],
};
const MONTH = {
  ...NOVEMBER,
  workplaces: [
    {
      groupId: 'g1',
      name: 'שופרסל',
      spellings: ['שופרסל'],
      rows: [{ name: 'Ziv', tickets: [ticket('t1'), ticket('t2')] }],
      unnamed: [],
    },
    {
      groupId: 'g2',
      name: 'שופר סל',
      spellings: ['שופר סל', 'שופר-סל'],
      rows: [],
      unnamed: [ticket('t3')],
    },
  ],
  questions: [QUESTION],
};

beforeEach(() => {
  replies['GET /api/auth/me'] = { status: 200, body: REVIEWER };
  replies['GET /api/progress'] = { status: 200, body: [] };
  replies['GET /api/months'] = { status: 200, body: [NOVEMBER] };
  replies['GET /api/months/m-nov'] = { status: 200, body: MONTH };
  replies['GET /api/lists/workplace'] = {
    status: 200,
    body: [{ name: 'דולב', spellings: ['Dolev'] }],
  };
  replies['GET /api/lists/name'] = {
    status: 200,
    body: [
      { name: 'Dana', spellings: ['דנה'] },
      { name: 'Kwame', spellings: [] },
    ],
  };
});

const answers = () => calls.filter((c) => c.path === '/api/flags/f1/resolve');
const fetched = (path: string) => calls.filter((c) => c.path === path).length;

describe('the Workplaces page', () => {
  it('asks whether two places are the same, with nothing chosen for the person', async () => {
    await open('/workplaces');
    expect(text()).toContain('November 2026');
    expect(text()).toContain('Is שופרסל the same place as שופר סל?');
    expect(text()).toContain('2 tickets');
    expect(text()).toContain('שופר-סל');
    const question = [...container.querySelectorAll('h3')].find((h) =>
      h.textContent?.startsWith('Is '),
    )!;
    expect(question.querySelectorAll('bdi')).toHaveLength(2);
    const labels = [
      'Same place, keep the name שופרסל',
      'Same place, keep the name שופר סל',
      'Different place',
    ];
    for (const label of labels) {
      expect(button(label)).toBeDefined();
      expect(button(label)!.className).toContain('MuiButton-outlined');
      expect(document.activeElement).not.toBe(button(label));
    }
    expect(button('See a ticket')?.getAttribute('href')).toBe('/months/m-nov/check/t1');
    // The workplaces of the month, with their spellings and counts.
    expect(text()).toContain('3 tickets in 2 workplaces');
  });

  it('asks "Are you sure?" before "same place", and Cancel sends nothing', async () => {
    await open('/workplaces');
    await click('Same place, keep the name שופר סל');
    expect(document.body.textContent).toContain('Are you sure?');
    expect(document.body.textContent).toContain('This cannot be undone.');
    await settle();
    expect(document.activeElement).toBe(dialogButton('Cancel'));
    await act(async () => dialogButton('Cancel')!.click());
    await settle();
    expect(answers()).toHaveLength(0);
  });

  it('sends "same place" with the name chosen, then asks for the month and tickets again', async () => {
    replies['POST /api/flags/f1/resolve'] = { status: 204 };
    await open('/workplaces');
    const before = fetched('/api/months/m-nov');
    await click('Same place, keep the name שופר סל');
    await act(async () => dialogButton('Same place')!.click());
    await settle();
    expect(answers().map((c) => c.body)).toEqual([{ decision: 'same_place', keepGroupId: 'g2' }]);
    expect(fetched('/api/months/m-nov')).toBeGreaterThan(before);
  });

  it('sends "different place" with one click, asks for the month again and moves the focus on', async () => {
    replies['POST /api/flags/f1/resolve'] = { status: 204 };
    await open('/workplaces');
    const before = fetched('/api/months/m-nov');
    replies['GET /api/months/m-nov'] = { status: 200, body: { ...MONTH, questions: [] } };
    await click('Different place');
    await settle();
    expect(answers().map((c) => c.body)).toEqual([{ decision: 'different_place' }]);
    expect(fetched('/api/months/m-nov')).toBeGreaterThan(before);
    expect(document.activeElement?.textContent).toBe('No workplace questions to answer.');
  });

  it('moves the focus to the next question of the month after an answer', async () => {
    const next = { ...QUESTION, flagId: 'f2' };
    replies['GET /api/months/m-nov'] = {
      status: 200,
      body: { ...MONTH, questions: [QUESTION, next] },
    };
    replies['POST /api/flags/f1/resolve'] = { status: 204 };
    await open('/workplaces');
    replies['GET /api/months/m-nov'] = { status: 200, body: { ...MONTH, questions: [next] } };
    await act(async () => button('Different place')!.click());
    await settle();
    expect(document.activeElement?.hasAttribute('data-question')).toBe(true);
  });

  it('names both places in "Are you sure?"', async () => {
    await open('/workplaces');
    await click('Same place, keep the name שופרסל');
    const dialog = document.querySelector('[role="dialog"]')!.textContent;
    expect(dialog).toContain('שופר סל and שופרסל become one workplace named שופרסל.');
  });

  it('offers Reload after a refused answer, which asks for the month again', async () => {
    replies['POST /api/flags/f1/resolve'] = {
      status: 409,
      body: { message: 'This question changed. Reload the page.' },
    };
    await open('/workplaces');
    await click('Different place');
    const before = fetched('/api/months/m-nov');
    await click('Reload');
    expect(fetched('/api/months/m-nov')).toBeGreaterThan(before);
    expect(text()).not.toContain('This question changed.');
  });

  it('shows the server message when the question was already answered, and reloads the month', async () => {
    replies['POST /api/flags/f1/resolve'] = {
      status: 409,
      body: { message: 'This question was already answered.' },
    };
    await open('/workplaces');
    const before = fetched('/api/months/m-nov');
    await click('Different place');
    expect(text()).toContain('This question was already answered.');
    expect(fetched('/api/months/m-nov')).toBeGreaterThan(before);
  });

  it('links to the spelling lists page while a month is open', async () => {
    await open('/workplaces');
    expect(button('The spelling lists')?.getAttribute('href')).toBe('/lists');
    expect(container.querySelector('#lists')).toBeNull();
  });

  // Before the first upload no month exists, but the lists must be set up for the first reading.
  it('shows the lists when no month is open, and can replace one', async () => {
    replies['GET /api/months'] = { status: 200, body: [{ ...NOVEMBER, status: 'closing' }] };
    replies['PUT /api/lists/workplace'] = {
      status: 200,
      body: [{ name: 'דולב', spellings: [] }],
    };
    await open('/workplaces');
    expect(text()).toContain('No open month.');
    expect(text()).toContain('Spelling lists');
    await edit('Workplace list', 'דולב');
    expect(text()).toContain('1 entry (was 1)');
    await act(async () => replaceButtons()[0]!.click());
    await settle();
    expect(document.activeElement).toBe(dialogButton('Cancel'));
    await act(async () => dialogButton('Replace')!.click());
    await settle();
    expect(calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body])).toEqual([
      ['/api/lists/workplace', { text: 'דולב' }],
    ]);
  });

  it('says when there is nothing to answer', async () => {
    replies['GET /api/months/m-nov'] = { status: 200, body: { ...MONTH, questions: [] } };
    await open('/workplaces');
    expect(text()).toContain('No workplace questions to answer.');
  });
});

/** Sets the textarea named `label` the way the browser does, so onChange fires. */
async function edit(label: string, value: string) {
  const area = [...container.querySelectorAll('textarea')].find((t) =>
    t.labels?.[0]?.textContent?.startsWith(label),
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return area;
}
const area = (label: string) =>
  [...container.querySelectorAll('textarea')].find((t) =>
    t.labels?.[0]?.textContent?.startsWith(label),
  )!;
const replaceButtons = () =>
  [...container.querySelectorAll('button')].filter((b) => b.textContent === 'Replace the list');

describe('the Spelling lists page', () => {
  it('the month page links its workplace questions', async () => {
    await open('/months/m-nov');
    expect(text()).toContain('1 workplace question to answer');
    expect(button('Answer workplace questions')?.getAttribute('href')).toBe('/workplaces');
  });

  it('shows each list as editable text', async () => {
    await open('/lists');
    expect(text()).toContain('Spelling lists');
    expect(area('Workplace list').value).toBe('דולב = Dolev');
    expect(area('Names list').value).toBe('Dana = דנה\nKwame');
    expect(area('Workplace list').getAttribute('dir')).toBe('auto');
    expect(text()).toContain('2 entries');
    for (const b of replaceButtons()) expect(b.disabled).toBe(true);
  });

  it('shows the problem with a pasted list and sends nothing', async () => {
    await open('/lists');
    await edit('Names list', 'x'.repeat(201));
    expect(text()).toContain('Line 1 is longer than 200 characters.');
    expect(replaceButtons()[1]!.disabled).toBe(true);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('replaces a list after saying what changes, and warns about names', async () => {
    replies['PUT /api/lists/name'] = {
      status: 200,
      body: [
        { name: 'Dana', spellings: ['דנה'] },
        { name: 'Yael', spellings: [] },
      ],
    };
    await open('/lists');
    await edit('Names list', 'Dana = דנה\nYael\n# a comment');
    expect(text()).toContain('2 entries (was 2): 1 new, 1 no longer on the list.');
    await act(async () => replaceButtons()[1]!.click());
    await settle();
    const dialog = document.querySelector('[role="dialog"]')!.textContent;
    expect(dialog).toContain('Names added from confirmed tickets that are not in your text');
    expect(dialog).toContain('Tickets already read are not read again.');
    await act(async () => dialogButton('Cancel')!.click());
    await settle();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    await act(async () => replaceButtons()[1]!.click());
    await settle();
    await act(async () => dialogButton('Replace')!.click());
    await settle();
    expect(calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body])).toEqual([
      ['/api/lists/name', { text: 'Dana = דנה\nYael\n# a comment' }],
    ]);
    expect(area('Names list').value).toBe('Dana = דנה\nYael');
  });

  it('counts the other spellings a replace drops from an entry that stays', async () => {
    await open('/lists');
    await edit('Workplace list', 'דולב');
    expect(text()).toContain(
      '1 entry (was 1): 0 new, 0 no longer on the list, 1 other spelling removed.',
    );
    await act(async () => replaceButtons()[0]!.click());
    await settle();
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain(
      '1 other spelling removed.',
    );
  });

  it('shows the server message when a list cannot be replaced', async () => {
    replies['PUT /api/lists/workplace'] = {
      status: 400,
      body: { message: 'The list is too long.' },
    };
    await open('/lists');
    await edit('Workplace list', 'דולב');
    await act(async () => replaceButtons()[0]!.click());
    await settle();
    await act(async () => dialogButton('Replace')!.click());
    await settle();
    expect(text()).toContain('The list is too long.');
    expect(area('Workplace list').value).toBe('דולב');
  });

  it('allows an empty list, and says so', async () => {
    replies['PUT /api/lists/workplace'] = { status: 200, body: [] };
    await open('/lists');
    await edit('Workplace list', '');
    expect(text()).toContain('The list will be empty (was 1).');
    await act(async () => replaceButtons()[0]!.click());
    await settle();
    expect(document.body.textContent).not.toContain('Names added from confirmed tickets');
    await act(async () => dialogButton('Replace')!.click());
    await settle();
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      path: '/api/lists/workplace',
      body: { text: '' },
    });
  });
});
