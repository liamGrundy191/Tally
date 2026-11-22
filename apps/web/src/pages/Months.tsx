// Home, the month page and the uploads still being read (section 9).
import {
  Alert,
  Box,
  Button,
  List,
  ListItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { formatMinutes } from '@tally/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  api,
  type Counts,
  type MonthTicket,
  type TicketStatus,
  stuck,
  unfinished,
  useMonth,
  useMonths,
  useProgress,
  useWaitingCount,
} from '../api.ts';
import { ConfirmDialog, REMOVE } from '../review/Review.tsx';
import { Lists } from './Lists.tsx';
import { ErrorMessage, Page } from './simple.tsx';

const STATUS: Record<TicketStatus, string> = {
  processing: 'Being read',
  verified: 'Ready',
  needs_review: 'Needs review',
  needs_manual_entry: 'Needs typing in',
  excluded: 'Removed',
};

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const monthName = (m: { year: number; month: number }) =>
  new Date(Date.UTC(m.year, m.month - 1)).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
/** Removed tickets are left out of the month's count. */
const total = (c: Counts) => c.processing + c.verified + c.needs_review + c.needs_manual_entry;
const needReview = (c: Counts) => c.needs_review + c.needs_manual_entry;
// Shift dates are stored as midnight UTC: show that day, wherever the browser is.
const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        timeZone: 'UTC',
      })
    : '—';

/** One line per upload still being read; the finished ones as one count. */
export function UploadsProgress() {
  const progress = useProgress();
  if (progress.error)
    return <ErrorMessage message={progress.error.message} retry={() => void progress.refetch()} />;
  const uploads = progress.data ?? [];
  const done = uploads.filter((u) => !unfinished(u) && !stuck(u)).length;
  const lines = uploads.filter((u) => unfinished(u) || stuck(u) || u.failedPages.length > 0);
  if (uploads.length === 0) return null;
  return (
    <Box sx={{ my: 2 }}>
      <Typography variant="h6" component="h2">
        Uploads
      </Typography>
      <List dense>
        {lines.map((u) => {
          const read = Object.values(u.tickets).reduce((a, b) => a + b, 0) - u.tickets.processing;
          const state = stuck(u)
            ? 'Reading this upload stopped. Tell your admin.'
            : u.splitting
              ? 'getting the pages ready to read…'
              : unfinished(u)
                ? `reading: ${read} of ${plural(u.pages ?? 0, 'page')} done.`
                : '';
          const failed = u.failedPages.length
            ? `${plural(u.failedPages.length, 'page')} could not be opened: scan them again.`
            : '';
          return (
            <ListItem key={u.id} disableGutters>
              <Typography>
                <bdi>{u.filename}</bdi>: {[state, failed].filter(Boolean).join(' ')}
              </Typography>
            </ListItem>
          );
        })}
      </List>
      {done > 0 && <Typography>{plural(done, 'upload')} fully read.</Typography>}
    </Box>
  );
}

export function Home() {
  const months = useMonths();
  const review = useWaitingCount('needs_review');
  const manual = useWaitingCount('needs_manual_entry');
  const waiting = (review.data?.total ?? 0) + (manual.data?.total ?? 0);
  const open = months.data?.filter((m) => m.status !== 'closed') ?? [];
  return (
    <Page title="Home">
      <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
        <Button variant="contained" component={Link} to="/upload">
          Upload
        </Button>
        <Button variant="contained" component={Link} to="/review">
          Review next
        </Button>
      </Box>
      {months.error ? (
        <ErrorMessage message={months.error.message} retry={() => void months.refetch()} />
      ) : months.isPending ? (
        <Typography>Loading the months…</Typography>
      ) : open.length === 0 ? (
        <>
          <Typography>No months yet. Upload scans to start.</Typography>
          <Typography>
            Before the first upload, set up the lists that help reading on the{' '}
            <Link to="/workplaces">Workplaces page</Link>.
          </Typography>
        </>
      ) : (
        <List>
          {open.map((m) => (
            <ListItem key={m.id} disableGutters>
              <Typography>
                <Link to={`/months/${m.id}`}>{monthName(m)}</Link>:{' '}
                {plural(total(m.tickets), 'ticket')}
                {needReview(m.tickets) > 0 && `, ${needReview(m.tickets)} need review`}
                {m.status === 'closing' && ' (being closed)'}
              </Typography>
            </ListItem>
          ))}
        </List>
      )}
      {(review.error ?? manual.error) && (
        <ErrorMessage
          message={(review.error ?? manual.error)!.message}
          retry={() => void Promise.all([review.refetch(), manual.refetch()])}
        />
      )}
      {waiting > 0 && (
        <Typography>
          <Link to="/review?month=none">
            {waiting === 1 ? '1 ticket waits' : `${waiting} tickets wait`} for a date.
          </Link>
        </Typography>
      )}
      <UploadsProgress />
    </Page>
  );
}

function TicketRows(props: {
  name: string;
  tickets: MonthTicket[];
  monthId: string;
  onRemove: (t: MonthTicket) => void;
}) {
  const { name, tickets } = props;
  return tickets.map((t, i) => (
    <TableRow key={t.id}>
      {i === 0 && (
        <TableCell rowSpan={tickets.length} dir="auto">
          {name}
        </TableCell>
      )}
      <TableCell>{day(t.shiftDate)}</TableCell>
      <TableCell>{t.totalMinutes === null ? '—' : formatMinutes(t.totalMinutes)}</TableCell>
      <TableCell>{STATUS[t.status]}</TableCell>
      <TableCell>
        <Button
          size="small"
          component={Link}
          to={`/review/${t.id}?month=${props.monthId}`}
          aria-label={`Open ${name}, ${day(t.shiftDate)}`}
        >
          Open
        </Button>
        <Button
          size="small"
          color="error"
          onClick={() => props.onRemove(t)}
          aria-label={`Remove ${name}, ${day(t.shiftDate)}`}
        >
          Remove
        </Button>
      </TableCell>
    </TableRow>
  ));
}

/** The search box matches a name, a workplace or a date, as shown on the page. */
const matches = (search: string, ...texts: string[]) =>
  texts.some((x) => x.toLowerCase().includes(search.trim().toLowerCase()));

export function Month() {
  const { id } = useParams();
  const month = useMonth(id!);
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [removing, setRemoving] = useState<MonthTicket | null>(null);
  const remove = useMutation({
    mutationFn: (t: MonthTicket) =>
      api(`/api/tickets/${t.id}/exclude`, 'POST', { version: t.version }),
    onSettled: () => {
      setRemoving(null);
      void client.invalidateQueries({ queryKey: ['months'] });
    },
  });
  if (month.error)
    return <ErrorMessage message={month.error.message} retry={() => void month.refetch()} />;
  if (!month.data) return <Typography>Loading the month…</Typography>;
  const m = month.data;
  const listed = m.workplaces.reduce(
    (n, w) => n + w.unnamed.length + w.rows.reduce((r, row) => r + row.tickets.length, 0),
    0,
  );
  // Tickets join a workplace once the month is sorted after reading (D45).
  const unsorted = total(m.tickets) - listed;
  const places = m.workplaces
    .map((w) => {
      const keep = (name: string) => (t: MonthTicket) =>
        !search || matches(search, name, w.name, day(t.shiftDate));
      return {
        ...w,
        rows: w.rows
          .map((r) => ({ ...r, tickets: r.tickets.filter(keep(r.name)) }))
          .filter((r) => r.tickets.length > 0),
        unnamed: w.unnamed.filter(keep('')),
      };
    })
    .filter((w) => w.rows.length + w.unnamed.length > 0);
  return (
    <Page title={monthName(m)}>
      <Typography>
        {plural(total(m.tickets), 'ticket')}: {m.tickets.verified} ready
        {m.tickets.processing > 0 && `, ${m.tickets.processing} being read`}.
      </Typography>
      {needReview(m.tickets) > 0 && (
        <Typography>
          {plural(needReview(m.tickets), 'ticket')} still need review and are left out of downloads.{' '}
          <Button variant="contained" size="small" component={Link} to={`/review?month=${m.id}`}>
            Review next
          </Button>
        </Typography>
      )}
      {m.tickets.excluded > 0 && (
        <Typography>{plural(m.tickets.excluded, 'ticket')} removed.</Typography>
      )}
      {unsorted > 0 && (
        <Typography>
          {unsorted === 1 ? '1 ticket is' : `${unsorted} tickets are`} not sorted into a workplace
          yet.
        </Typography>
      )}
      {m.questions.length > 0 && (
        <Typography>
          <Link to="/workplaces">{plural(m.questions.length, 'workplace question')} to answer</Link>
          : until then their tickets are left out of downloads.
        </Typography>
      )}
      <UploadsProgress />
      {remove.error && <Alert severity="error">{remove.error.message}</Alert>}
      <TextField
        label="Search by name, workplace or date"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        size="small"
        fullWidth
        sx={{ mt: 2 }}
        slotProps={{ htmlInput: { dir: 'auto' } }}
      />
      {search && places.length === 0 && <Typography sx={{ mt: 2 }}>No ticket matches.</Typography>}
      {places.map((w) => (
        <Box key={w.groupId} sx={{ mt: 3 }}>
          <Typography variant="h6" component="h2" dir="auto">
            {w.name}
          </Typography>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Date</TableCell>
                <TableCell>Hours</TableCell>
                <TableCell>Status</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {w.rows.map((r) => (
                <TicketRows
                  key={r.name}
                  name={r.name}
                  tickets={r.tickets}
                  monthId={m.id}
                  onRemove={setRemoving}
                />
              ))}
              {w.unnamed.length > 0 && (
                <TicketRows
                  name="Name not confirmed yet"
                  tickets={w.unnamed}
                  monthId={m.id}
                  onRemove={setRemoving}
                />
              )}
            </TableBody>
          </Table>
        </Box>
      ))}
      <ConfirmDialog
        open={removing !== null}
        {...REMOVE}
        busy={remove.isPending}
        onConfirm={() => remove.mutate(removing!)}
        onClose={() => setRemoving(null)}
      />
      <Lists />
    </Page>
  );
}
