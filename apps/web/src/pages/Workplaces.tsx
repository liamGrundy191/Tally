// The Workplaces page (section 9): each open month's "is this the same place?" questions (5.3),
// then its workplaces. Only a person decides that two spellings are one place.
import {
  Alert,
  Box,
  Button,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Fragment, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, type MonthDetail, useMonth, useMonths } from '../api.ts';
import { ConfirmDialog } from '../review/Review.tsx';
import { Lists } from './Lists.tsx';
import { monthName, plural } from './Months.tsx';
import { ErrorMessage, Page } from './simple.tsx';

type Question = MonthDetail['questions'][number];
type Side = Question['groups'][number];
type Answer = {
  flagId: string;
  decision: 'same_place' | 'different_place';
  keep?: Side;
  other?: Side;
};

/** Spellings as "a, b and c", each in its own <bdi> so Hebrew reads right to left. */
const spelled = (xs: string[]) =>
  xs.map((x, i) => (
    <Fragment key={x}>
      {i === 0 ? '' : i === xs.length - 1 ? ' and ' : ', '}
      <bdi>{x}</bdi>
    </Fragment>
  ));

/** Equal answers, in sentence case so a Hebrew name inside reads as written. */
const BUTTON = { flex: 1, textTransform: 'none' } as const;

export function Workplaces() {
  const months = useMonths();
  if (months.error)
    return <ErrorMessage message={months.error.message} retry={() => void months.refetch()} />;
  if (!months.data) return <Typography>Loading the months…</Typography>;
  // A month being closed takes no answers.
  const open = months.data.filter((m) => m.status === 'open');
  return (
    <Page title="Workplaces">
      {/* No month exists before the first upload, yet the lists should help its first reading. */}
      {open.length === 0 && (
        <>
          <Typography>No open month.</Typography>
          <Lists />
        </>
      )}
      {open.map((m) => (
        <MonthPlaces key={m.id} id={m.id} />
      ))}
    </Page>
  );
}

function MonthPlaces({ id }: { id: string }) {
  const month = useMonth(id);
  const client = useQueryClient();
  // What the dialog asks about; kept while it closes, so its text does not go blank.
  const [asking, setAsking] = useState<Answer | null>(null);
  const [sure, setSure] = useState(false);
  const section = useRef<HTMLDivElement>(null);
  const focusNext = useRef(false);
  const answer = useMutation({
    mutationFn: (a: Answer) =>
      api(`/api/flags/${a.flagId}/resolve`, 'POST', {
        decision: a.decision,
        ...(a.keep && { keepGroupId: a.keep.id }),
      }),
    // Also after a refusal: the question may have been answered or changed meanwhile.
    onSettled: () => {
      setSure(false);
      focusNext.current = true;
      void client.invalidateQueries({ queryKey: ['months'] });
      void client.invalidateQueries({ queryKey: ['tickets'] });
    },
  });
  // Once the month is loaded again: this month's next question, or "No workplace questions", so a
  // keyboard user carries on from there.
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    section.current?.querySelector<HTMLElement>('[data-question], [data-none]')?.focus();
  }, [month.dataUpdatedAt]);
  if (month.error)
    return <ErrorMessage message={month.error.message} retry={() => void month.refetch()} />;
  if (!month.data) return <Typography>Loading the month…</Typography>;
  const m = month.data;
  const places = m.workplaces
    .map((w) => ({
      ...w,
      count: w.unnamed.length + w.rows.reduce((n, r) => n + r.tickets.length, 0),
    }))
    .filter((w) => w.count > 0);
  const tickets = places.reduce((n, w) => n + w.count, 0);

  return (
    <Box sx={{ mb: 4 }} ref={section}>
      <Typography variant="h5" component="h2" gutterBottom>
        <Link to={`/months/${m.id}`}>{monthName(m)}</Link>
      </Typography>
      {answer.error && (
        <Alert
          severity="error"
          action={
            <Button
              color="inherit"
              onClick={() => {
                answer.reset();
                void month.refetch();
              }}
            >
              Reload
            </Button>
          }
        >
          {answer.error.message}
        </Alert>
      )}
      {m.questions.length === 0 && (
        <Typography tabIndex={-1} data-none>
          No workplace questions to answer.
        </Typography>
      )}
      <Stack spacing={2}>
        {m.questions.map((q) => (
          <Box
            key={q.flagId}
            sx={{ border: 2, borderColor: 'warning.main', borderRadius: 1, p: 2 }}
          >
            <Typography variant="h6" component="h3" tabIndex={-1} data-question>
              Is <bdi>{q.groups[0]!.name}</bdi> the same place as <bdi>{q.groups[1]!.name}</bdi>?
            </Typography>
            {q.groups.map((g) => (
              <Typography key={g.id}>
                <bdi>{g.name}</bdi>: {plural(g.tickets, 'ticket')}, written as{' '}
                {spelled(g.spellings)}.{' '}
                {g.ticketId && <Link to={`/review/${g.ticketId}?month=${m.id}`}>See a ticket</Link>}
              </Typography>
            ))}
            {/* Three equal answers; none is chosen or focused for the person. */}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ my: 2 }}>
              {q.groups.map((g, i) => (
                <Button
                  key={g.id}
                  variant="outlined"
                  disabled={answer.isPending}
                  sx={BUTTON}
                  onClick={() => {
                    setAsking({
                      flagId: q.flagId,
                      decision: 'same_place',
                      keep: g,
                      other: q.groups[1 - i],
                    });
                    setSure(true);
                  }}
                >
                  {/* One block of text, the name on its own line and never split. */}
                  <span>
                    Same place, keep the name{' '}
                    <bdi style={{ display: 'block', whiteSpace: 'nowrap' }}>{g.name}</bdi>
                  </span>
                </Button>
              ))}
              <Button
                variant="outlined"
                disabled={answer.isPending}
                sx={BUTTON}
                onClick={() => answer.mutate({ flagId: q.flagId, decision: 'different_place' })}
              >
                Different place
              </Button>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              Same place makes them one workplace for every ticket of both, and adds the other
              spelling to the workplace list. This cannot be undone.
            </Typography>
          </Box>
        ))}
      </Stack>
      <Typography sx={{ mt: 3 }}>
        {plural(tickets, 'ticket')} in {plural(places.length, 'workplace')}.{' '}
        <Link to={`/months/${m.id}#lists`}>The lists that help reading</Link> are on the month page.
      </Typography>
      {places.length > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Workplace</TableCell>
              <TableCell>Written as</TableCell>
              <TableCell>Tickets</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {places.map((w) => (
              <TableRow key={w.groupId}>
                <TableCell dir="auto">{w.name}</TableCell>
                <TableCell>{spelled(w.spellings)}</TableCell>
                <TableCell>{w.count}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <ConfirmDialog
        open={sure}
        title="Are you sure?"
        text={
          <>
            <bdi>{asking?.other?.name}</bdi> and <bdi>{asking?.keep?.name}</bdi> become one
            workplace named <bdi>{asking?.keep?.name}</bdi>. This cannot be undone.
          </>
        }
        confirm="Same place"
        busy={answer.isPending}
        onConfirm={() => answer.mutate(asking!)}
        onClose={() => setSure(false)}
      />
    </Box>
  );
}
