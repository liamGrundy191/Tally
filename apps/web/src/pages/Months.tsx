// Home, the month page and the uploads still being read (section 9).
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  List,
  ListItem,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import {
  AGENCY_TIME_ZONE,
  autoDeleteOn,
  formatMinutes,
  isMonthName,
  monthName,
  todayIn,
  warnFrom,
} from '@tally/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  api,
  download,
  type Counts,
  type MonthSummary,
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
import { ErrorMessage, Page } from './simple.tsx';
import { Upload } from './Upload.tsx';

const STATUS: Record<TicketStatus, string> = {
  processing: 'Being read',
  verified: 'Ready',
  needs_review: 'To check',
  needs_manual_entry: 'To type in',
  excluded: 'Removed',
};

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export { monthName };
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

// The month's two files, as the server names them (6.2, 6.3).
const mm = (m: MonthSummary) => `${m.year}-${String(m.month).padStart(2, '0')}`;
const saveExcel = (m: MonthSummary) => download(`/api/months/${m.id}/excel`, `hours-${mm(m)}.xlsx`);
const saveZip = (m: MonthSummary) => download(`/api/months/${m.id}/pdfs`, `tickets-${mm(m)}.zip`);
/** When a month was closed, as a date in Israel. */
const closedOn = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    timeZone: AGENCY_TIME_ZONE,
  });

/** From day 50, an open month is about to be deleted automatically (6.1). */
function DeleteWarning({ m }: { m: MonthSummary }) {
  if (m.status !== 'open' || todayIn(AGENCY_TIME_ZONE) < warnFrom(m)) return null;
  return (
    <Alert severity="warning" sx={{ my: 1 }}>
      {monthName(m)} will be deleted automatically on {day(`${autoDeleteOn(m)}T00:00:00Z`)}.
      Download its files and close it before then.
    </Alert>
  );
}

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
    <Box sx={{ mt: 1 }}>
      <List dense disablePadding>
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

/** Where a month stands, as one rubber stamp (the official-form look, D63). */
type StampState = 'open' | 'checked' | 'closing' | 'closed';
function stampOf(m: MonthSummary): StampState {
  if (m.status !== 'open') return m.status;
  const done = needReview(m.tickets) === 0 && m.tickets.processing === 0 && total(m.tickets) > 0;
  return done ? 'checked' : 'open';
}
const STAMP: Record<StampState, { label: string; color: string }> = {
  open: { label: 'Open', color: 'primary.main' },
  checked: { label: 'Checked', color: 'success.main' },
  closing: { label: 'Closing', color: 'text.secondary' },
  closed: { label: 'Closed', color: 'text.secondary' },
};

function Stamp({ m }: { m: MonthSummary }) {
  const s = STAMP[stampOf(m)];
  return (
    <Box
      component="span"
      sx={{
        flex: 'none',
        border: '2.5px solid',
        borderColor: s.color,
        color: s.color,
        borderRadius: 1,
        px: 1.25,
        fontSize: 14,
        lineHeight: '26px',
        fontWeight: 800,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        transform: 'rotate(-4deg)',
      }}
    >
      {s.label}
    </Box>
  );
}

/** The month's counts in one ruled row; the number to act on is the largest. */
function Fields({ items }: { items: { label: string; value: ReactNode; act?: boolean }[] }) {
  return (
    <Box
      component="dl"
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: `repeat(${items.length}, 1fr)` },
        borderTop: 1,
        borderColor: 'divider',
        m: 0,
        mt: 2,
      }}
    >
      {items.map((f, i) => (
        <Box
          key={f.label}
          sx={{
            pt: 1.5,
            pr: 2,
            // Two to a row on a phone, all in one row from tablet width.
            pl: { xs: i % 2 ? 2 : 0, sm: i ? 2 : 0 },
            borderLeft: { xs: i % 2 ? 1 : 0, sm: i ? 1 : 0 },
            borderColor: 'divider',
          }}
        >
          <Typography component="dt" variant="body2" color="text.secondary">
            {f.label}
          </Typography>
          <Typography
            component="dd"
            sx={{
              m: 0,
              fontSize: f.act ? 34 : 22,
              fontWeight: f.act ? 700 : 500,
              lineHeight: 1.25,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {f.value}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

/** One plain sentence: what this month needs next. */
function nextStep(m: MonthSummary) {
  if (m.status === 'closed') return `Closed on ${closedOn(m.closedAt!)}. Only its summary is kept.`;
  if (m.status === 'closing') return 'Being closed: its tickets and scans are being deleted.';
  const toCheck = needReview(m.tickets);
  if (toCheck > 0) return `${plural(toCheck, 'ticket')} to check before the Excel is complete.`;
  if (m.tickets.processing > 0) return 'Tickets are still being read. Nothing to check yet.';
  if (total(m.tickets) === 0) return 'No tickets yet.';
  return 'Every ticket is checked. Download the files, then close the month.';
}

function MonthCard({ m, label }: { m: MonthSummary; label: string }) {
  const closed = m.status === 'closed';
  return (
    <Paper component="section" aria-label={monthName(m)} sx={{ p: 3, mb: 2.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
        <Box sx={{ flex: 1 }}>
          <Typography variant="h5" component="h2">
            {monthName(m)}
          </Typography>
          <Typography color="text.secondary">{label}</Typography>
        </Box>
        <Stamp m={m} />
      </Box>
      <Typography sx={{ mt: 1.5 }}>{nextStep(m)}</Typography>
      <DeleteWarning m={m} />
      {closed ? (
        <Fields
          items={[
            { label: 'Ready tickets', value: m.summaryTicketCount ?? 0 },
            { label: 'Hours', value: formatMinutes(m.summaryTotalMinutes ?? 0) },
          ]}
        />
      ) : (
        <>
          <Fields
            items={[
              { label: 'To check', value: needReview(m.tickets), act: true },
              { label: 'Ready', value: m.tickets.verified },
              { label: 'Being read', value: m.tickets.processing },
              { label: 'All tickets', value: total(m.tickets) },
            ]}
          />
          <Button variant="contained" component={Link} to={`/months/${m.id}`} sx={{ mt: 2.5 }}>
            Open {monthName(m)}
          </Button>
        </>
      )}
    </Paper>
  );
}

/** Tickets read without a date belong to no month yet (D45). */
function WaitingForDate() {
  const review = useWaitingCount('needs_review');
  const manual = useWaitingCount('needs_manual_entry');
  const waiting = (review.data?.total ?? 0) + (manual.data?.total ?? 0);
  const error = review.error ?? manual.error;
  if (error)
    return (
      <ErrorMessage
        message={error.message}
        retry={() => void Promise.all([review.refetch(), manual.refetch()])}
      />
    );
  if (waiting === 0) return null;
  return (
    <Box
      role="note"
      sx={{
        p: 2.5,
        display: 'flex',
        gap: 2,
        alignItems: 'center',
        flexWrap: 'wrap',
        bgcolor: '#fff7e6',
        border: '1px solid #e8c77a',
        borderRadius: 1,
      }}
    >
      <Typography sx={{ flex: 1, minWidth: 220 }}>
        {waiting === 1 ? '1 ticket has' : `${waiting} tickets have`} no readable date yet, so
        {waiting === 1 ? ' it is' : ' they are'} in no month.
      </Typography>
      <Button variant="outlined" component={Link} to="/review?month=none">
        Add the {waiting === 1 ? 'date' : 'dates'}
      </Button>
    </Box>
  );
}

const newest = (a: MonthSummary, b: MonthSummary) => b.year - a.year || b.month - a.month;

/** Home (Liam, D63): the current and previous month, and uploading on the right. */
export function Home() {
  const months = useMonths();
  const shown = [...(months.data ?? [])].sort(newest).slice(0, 2);
  return (
    <Box>
      <Typography variant="h4" component="h1" sx={{ mb: 3 }}>
        Your months
      </Typography>
      <Box
        sx={{
          display: 'grid',
          gap: 4,
          gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) 400px' },
          alignItems: 'start',
        }}
      >
        <Box>
          {months.error ? (
            <ErrorMessage message={months.error.message} retry={() => void months.refetch()} />
          ) : months.isPending ? (
            <Typography>Loading the months…</Typography>
          ) : shown.length === 0 ? (
            <Paper sx={{ p: 3, mb: 2.5 }}>
              <Typography>
                No months yet. Upload the first scans on the right: Tally reads each ticket and
                files it under the month written on it.
              </Typography>
            </Paper>
          ) : (
            shown.map((m, i) => (
              <MonthCard key={m.id} m={m} label={i === 0 ? 'Current month' : 'Previous month'} />
            ))
          )}
          <WaitingForDate />
        </Box>
        <Paper component="section" aria-label="Upload scans" sx={{ p: 3 }}>
          <Upload embedded />
          <UploadsProgress />
        </Paper>
      </Box>
    </Box>
  );
}

/** A numbered section of the month page: the order is the order of the work. */
function Section(props: { n: number; title: string; children: ReactNode }) {
  return (
    <Paper component="section" aria-label={props.title} sx={{ p: 3, mb: 2.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
        <Box
          aria-hidden
          sx={{
            width: 30,
            height: 30,
            border: '1.5px solid',
            borderColor: 'primary.main',
            borderRadius: 0.5,
            display: 'grid',
            placeItems: 'center',
            fontWeight: 700,
            color: 'primary.main',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {props.n}
        </Box>
        <Typography variant="h6" component="h2">
          {props.title}
        </Typography>
      </Box>
      {props.children}
    </Paper>
  );
}

const Actions = ({ children }: { children: ReactNode }) => (
  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 2 }}>{children}</Box>
);

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
          to={`/months/${props.monthId}/check/${t.id}`}
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
  // Other open months are reached from here, not Home (Liam, D63).
  const months = useMonths();
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
  const excel = useMutation({ mutationFn: () => saveExcel(month.data!) });
  const [closing, setClosing] = useState(false);
  const [typed, setTyped] = useState('');
  const [fresh, setFresh] = useState(true);
  // Close (Liam, Q15): with the box ticked, the final files are downloaded first, and the month is
  // closed only if both arrived, so the files kept are the month as it is closed.
  const close = useMutation({
    mutationFn: async () => {
      const m = month.data!;
      if (fresh) {
        await saveExcel(m);
        await saveZip(m);
      }
      await api(`/api/months/${m.id}/close`, 'POST', { name: typed });
    },
    onSuccess: () => {
      setClosing(false);
      void client.invalidateQueries({ queryKey: ['months'] });
    },
  });
  // All the workplace PDFs in one ZIP, or one workplace's PDF (6.3).
  const pdfs = useMutation({
    mutationFn: (w?: { groupId: string; name: string }) => {
      const m = month.data!;
      return w
        ? download(`/api/months/${m.id}/pdfs?workplace=${w.groupId}`, `${w.name}.pdf`)
        : saveZip(m);
    },
  });
  if (month.error)
    return <ErrorMessage message={month.error.message} retry={() => void month.refetch()} />;
  if (!month.data) return <Typography>Loading the month…</Typography>;
  const m = month.data;
  // A closed month keeps only its summary (6.4); one being closed shows nothing to act on.
  if (m.status === 'closed') {
    return (
      <Page title={monthName(m)}>
        <Typography>
          Closed on {closedOn(m.closedAt!)}. Its tickets and scans were deleted; the summary is
          kept: {plural(m.summaryTicketCount ?? 0, 'ready ticket')},{' '}
          {formatMinutes(m.summaryTotalMinutes ?? 0)} hours.
        </Typography>
      </Page>
    );
  }
  if (m.status === 'closing') {
    return (
      <Page title={monthName(m)}>
        <Typography>
          This month is being closed: its tickets and scans are being deleted.
        </Typography>
      </Page>
    );
  }
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
        ready: w.rows.some((r) => r.tickets.some((t) => t.status === 'verified')),
        rows: w.rows
          .map((r) => ({ ...r, tickets: r.tickets.filter(keep(r.name)) }))
          .filter((r) => r.tickets.length > 0),
        unnamed: w.unnamed.filter(keep('')),
      };
    })
    .filter((w) => w.rows.length + w.unnamed.length > 0);
  const toCheck = needReview(m.tickets);
  const others = (months.data ?? [])
    .filter((o) => o.status !== 'closed' && o.id !== m.id)
    .sort(newest);
  return (
    <Box sx={{ maxWidth: 860 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="h4" component="h1">
          {monthName(m)}
        </Typography>
        <Stamp m={m} />
      </Box>
      <Typography color="text.secondary" sx={{ mt: 1, mb: 3 }}>
        {nextStep(m)}
      </Typography>
      {others.length > 0 && (
        <Typography sx={{ mb: 2 }}>
          Also open:{' '}
          {others.map((o, i) => (
            <span key={o.id}>
              {i > 0 && ', '}
              <Link to={`/months/${o.id}`}>{monthName(o)}</Link>
              {needReview(o.tickets) > 0 && ` (${needReview(o.tickets)} to check)`}
            </span>
          ))}
        </Typography>
      )}
      <DeleteWarning m={m} />
      <Section n={1} title="Check the tickets">
        <Typography>
          {toCheck > 0
            ? `${plural(toCheck, 'ticket')} to check. Until checked, they are left out of the downloads.`
            : m.tickets.processing > 0
              ? `${m.tickets.processing} still being read. Nothing to check yet.`
              : 'Every ticket is checked.'}
        </Typography>
        {m.questions.length > 0 && (
          <Typography sx={{ mt: 1 }}>
            {plural(m.questions.length, 'workplace question')} to answer: until then their tickets
            are left out of the downloads.
          </Typography>
        )}
        {unsorted > 0 && (
          <Typography sx={{ mt: 1 }}>
            {unsorted === 1 ? '1 ticket is' : `${unsorted} tickets are`} not sorted into a workplace
            yet.
          </Typography>
        )}
        <Actions>
          {toCheck > 0 && (
            <Button variant="contained" component={Link} to={`/months/${m.id}/check`}>
              Check next
            </Button>
          )}
          {m.questions.length > 0 && (
            <Button variant="outlined" component={Link} to="/workplaces">
              Answer workplace questions
            </Button>
          )}
        </Actions>
      </Section>
      {m.status === 'open' && (
        <>
          <Section n={2} title="Download the files">
            <Typography>
              {plural(m.tickets.verified, 'ticket')} ready for the Excel
              {m.tickets.excluded > 0 && `; ${m.tickets.excluded} removed`}. Tickets still to check
              are left out.
            </Typography>
            <Actions>
              <Button variant="contained" disabled={excel.isPending} onClick={() => excel.mutate()}>
                Download Excel
              </Button>
              <Button
                variant="outlined"
                disabled={pdfs.isPending}
                onClick={() => pdfs.mutate(undefined)}
              >
                Workplace PDFs
              </Button>
            </Actions>
            {excel.error && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {excel.error.message}
              </Alert>
            )}
            {pdfs.error && !pdfs.variables && (
              <Alert severity="error" sx={{ mt: 2 }}>
                {pdfs.error.message}
              </Alert>
            )}
          </Section>
          <Section n={3} title="Close the month">
            <Typography>
              When the files are downloaded and sent, close the month. Its tickets and scans are
              deleted for good; only a summary is kept.
            </Typography>
            <Actions>
              <Button
                variant="outlined"
                color="error"
                onClick={() => {
                  setTyped('');
                  setFresh(true);
                  close.reset();
                  setClosing(true);
                }}
              >
                Close month
              </Button>
            </Actions>
          </Section>
        </>
      )}
      <Paper component="section" aria-label="All tickets" sx={{ p: 3 }}>
        <Typography variant="h6" component="h2" sx={{ mb: 2 }}>
          All tickets ({total(m.tickets)})
        </Typography>
        {remove.error && <Alert severity="error">{remove.error.message}</Alert>}
        <TextField
          label="Search by name, workplace or date"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          size="small"
          fullWidth
          slotProps={{ htmlInput: { dir: 'auto' } }}
        />
        {search && places.length === 0 && (
          <Typography sx={{ mt: 2 }}>No ticket matches.</Typography>
        )}
        {places.map((w) => (
          <Box key={w.groupId} sx={{ mt: 3 }}>
            <Typography variant="h6" component="h3" dir="auto">
              {w.name}
            </Typography>
            {m.status === 'open' && w.ready && (
              <Button
                size="small"
                aria-label={`Download PDF for ${w.name}`}
                disabled={pdfs.isPending}
                onClick={() => pdfs.mutate(w)}
              >
                Download PDF
              </Button>
            )}
            {pdfs.error && pdfs.variables?.groupId === w.groupId && (
              <Alert severity="error">{pdfs.error.message}</Alert>
            )}
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
      </Paper>
      <ConfirmDialog
        open={removing !== null}
        {...REMOVE}
        busy={remove.isPending}
        onConfirm={() => remove.mutate(removing!)}
        onClose={() => setRemoving(null)}
      />
      <Dialog open={closing} onClose={() => setClosing(false)} aria-labelledby="close-title">
        <DialogTitle id="close-title">Close {monthName(m)}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Closing deletes this month's tickets and scans for good; only a summary is kept. Type
            the month's name to close it.
          </DialogContentText>
          {needReview(m.tickets) > 0 && (
            <Alert severity="warning" sx={{ my: 1 }}>
              {plural(needReview(m.tickets), 'ticket')} still to check: check or remove them first.
            </Alert>
          )}
          <FormControlLabel
            control={<Checkbox checked={fresh} onChange={(e) => setFresh(e.target.checked)} />}
            label="Download the final Excel and workplace PDFs now"
          />
          <Typography variant="body2" sx={{ mb: 2 }}>
            Untick only if you already have the latest files.
          </Typography>
          <TextField
            label={`Type ${monthName(m)}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            size="small"
            fullWidth
            autoFocus
          />
          {close.error && <Alert severity="error">{close.error.message}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClosing(false)}>Cancel</Button>
          <Button
            color="error"
            disabled={!isMonthName(typed, m) || close.isPending}
            onClick={() => close.mutate()}
          >
            Close month
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
