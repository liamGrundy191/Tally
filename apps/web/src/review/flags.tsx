// Each flag in plain words (plan 4.1), with the values it is about. Values come from the ticket
// and the reader, so each one sits in its own <bdi>: Hebrew reads right to left inside English.
import { type FieldKey, type FlagCode, formatMinutes } from '@tally/shared';
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { TicketDetail, TicketFlag } from '../api.ts';

export const FIELD_NAMES: Record<FieldKey, string> = {
  firstName: 'first name',
  workplace: 'workplace',
  date: 'date',
  startTime: 'start time',
  endTime: 'end time',
  totalWorked: 'total',
};

/** Short names for the queue's "Only tickets with" choice. */
export const FLAG_LABELS: Record<FlagCode, string> = {
  PASS_DISAGREEMENT: 'The two readings disagree',
  FIELD_UNREADABLE: 'Could not read a box',
  FIELD_EMPTY: 'An empty box',
  CORRECTION_MARKS: 'A box looks overwritten',
  VOIDED_TICKET: 'Looks crossed out',
  TIME_INVALID: 'Not a real time',
  TIME_MATH_MISMATCH: 'The times do not add up',
  HOURS_OUT_OF_RANGE: 'Unusual hours',
  DATE_IN_FUTURE: 'Date in the future',
  DATE_TOO_OLD: 'Date long ago',
  DATE_INVALID: 'Not a real date',
  SCRIPT_UNEXPECTED: 'Unusual characters in the name',
  MARKERS_NOT_FOUND: 'Corner markers not found',
  IMAGE_BLURRY: 'Blurry scan',
  IMAGE_DARK: 'Dark scan',
  WORKPLACE_SIMILAR: 'A workplace like another',
  WORKPLACE_NOT_ON_LIST: 'A workplace not on the list',
  MATCH_AMBIGUOUS: 'Could be either of two list entries',
  POSSIBLE_DUPLICATE: 'Possible duplicate',
  MONTH_CLOSED: 'Month already closed',
  NAME_NOT_CONFIRMED: 'Name not in English letters yet',
  EXTRACTION_ERROR: 'Could not be read at all',
};

const shown = (x: unknown) => (x === null || x === undefined || x === '' ? 'nothing' : String(x));
const value = (x: unknown) => <bdi>{shown(x)}</bdi>;
/** "a and b", "a, b and c", each value in its own <bdi>. */
const values = (xs: unknown[], last = ' and ') =>
  xs.map((x, i) => (
    <Fragment key={i}>
      {i === 0 ? '' : i === xs.length - 1 ? last : ', '}
      {value(x)}
    </Fragment>
  ));
const minutes = (x: unknown) => (typeof x === 'number' ? formatMinutes(x) : shown(x));
/** "2026-11-13" (or a stored ISO date) as 13/11/26, the way the ticket has it. */
export const dayOf = (iso: string | null | undefined) =>
  iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(2, 4)}` : '—';

/** The flag's reason, as the review screen shows it. */
export function reason(flag: TicketFlag, ticket?: TicketDetail): ReactNode {
  const d = flag.detail ?? {};
  const field = flag.field ? FIELD_NAMES[flag.field] : 'box';
  switch (flag.code) {
    case 'PASS_DISAGREEMENT':
      if ('matchA' in d)
        return <>The two readings matched different list entries: {values([d.matchA, d.matchB])}</>;
      return <>The two readings disagree: {values([d.passA, d.passB])}</>;
    case 'FIELD_UNREADABLE': {
      const read = [d.passA ?? d.suggestionA, d.passB ?? d.suggestionB, d.passC].filter(
        (x) => x !== null && x !== undefined && x !== '',
      );
      const distinct = [...new Set(read.map(String))];
      return (
        <>
          Could not read the {field}
          {distinct.length > 0 && <>. It was read as {values(distinct)}</>}
        </>
      );
    }
    case 'FIELD_EMPTY':
      return <>The {field} is empty</>;
    case 'CORRECTION_MARKS':
      return <>The {field} looks overwritten</>;
    case 'VOIDED_TICKET':
      return <>This ticket looks crossed out. Remove it?</>;
    case 'TIME_INVALID':
      return <>{value(d.value)} is not a real time</>;
    case 'TIME_MATH_MISMATCH':
      return (
        <>
          Start and end give {value(minutes(d.computed))}, but total says {value(minutes(d.total))}
        </>
      );
    case 'HOURS_OUT_OF_RANGE': {
      const short = typeof d.minutes === 'number' && d.minutes < Number(d.minHours) * 60;
      return (
        <>
          {flag.field ? 'Total' : 'A shift'} of {value(minutes(d.minutes))} is unusually{' '}
          {short ? 'short' : 'long'}
        </>
      );
    }
    case 'DATE_IN_FUTURE':
      return <>The date is in the future</>;
    case 'DATE_TOO_OLD':
      return <>The date is more than {shown(d.maxDays ?? 45)} days ago</>;
    case 'DATE_INVALID':
      return <>{value(d.value)} is not a real date</>;
    case 'SCRIPT_UNEXPECTED':
      return d.problem === 'mixed_scripts' ? (
        <>The name mixes Hebrew and English letters: check the reading</>
      ) : (
        <>The name has characters that are not letters: check the reading</>
      );
    case 'MARKERS_NOT_FOUND':
      return <>The corner markers were not found: check every box against the scan</>;
    case 'IMAGE_BLURRY':
      return <>The scan is blurry: check every box against it</>;
    case 'IMAGE_DARK':
      return <>The scan is dark: check every box against it</>;
    case 'WORKPLACE_SIMILAR':
      // No names: those stored with the question can be out of date after a merge.
      return (
        <>
          This workplace is written like another one. Answer whether they are the same place on the{' '}
          <Link to="/workplaces">Workplaces page</Link>.
        </>
      );
    case 'WORKPLACE_NOT_ON_LIST': {
      const written = Array.isArray(d.written) ? d.written[0] : undefined;
      return (
        <>Is {value(ticket?.workplaceRaw ?? written)} a new workplace? It is not on the list.</>
      );
    }
    case 'MATCH_AMBIGUOUS': {
      const others = Array.isArray(d.alsoFits) ? d.alsoFits : [];
      if (others.length > 0) return <>Is this {values([d.match, ...others], ' or ')}?</>;
      return (
        <>
          The list has {value(d.match)}, but the writing was read clearly as something else: which
          is it?
        </>
      );
    }
    case 'POSSIBLE_DUPLICATE': {
      const other = ticket?.related.find((r) => r.id === flag.relatedTicketId);
      return (
        <>
          There is already a ticket for {value(other?.workerName ?? other?.firstName)} here on{' '}
          {dayOf(other?.shiftDate)}
        </>
      );
    }
    case 'NAME_NOT_CONFIRMED':
      return <>Confirm the name in English letters</>;
    case 'MONTH_CLOSED': {
      const name =
        typeof d.year === 'number' && typeof d.month === 'number'
          ? new Date(Date.UTC(d.year, d.month - 1)).toLocaleDateString('en-GB', {
              month: 'long',
              year: 'numeric',
              timeZone: 'UTC',
            })
          : 'This month';
      return (
        <>{name} is already closed. Remove this ticket and add it to the final Excel by hand.</>
      );
    }
    case 'EXTRACTION_ERROR':
      return <>Could not read this ticket. Please type it in.</>;
  }
}
