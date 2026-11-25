// Home, the month page and the uploads still being read (section 9).
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Avatar,
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
import { Link, useLocation, useParams } from 'react-router';
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
import { Lists } from './Lists.tsx';
import { ErrorMessage, Page } from './simple.tsx';

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

/** One step of the month (design pass, T5.1): a number, a title, what is left, one action. */
function Step(props: { n: number; title: string; done?: boolean; children: ReactNode }) {
  return (
    <Paper sx={{ p: 2.5, mb: 2, display: 'flex', gap: 2, alignItems: 'flex-start' }}>
      <Avatar
        sx={{
          bgcolor: props.done ? 'success.main' : 'primary.main',
          width: 32,
          height: 32,
          fontSize: 16,
        }}
        aria-hidden
      >
        {props.done ? '✓' : props.n}
      </Avatar>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="h6" component="h2" sx={{ mb: 0.5 }}>
          {props.title}
        </Typography>
        {props.children}
      </Box>
    </Paper>
  );
}

const Actions = ({ children }: { children: ReactNode }) => (
  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 1.5 }}>{children}</Box>
);

function PrintStep() {
  return (
    <Step n={1} title="Print tickets">
      <Typography color="text.secondary">
        Blank tickets for the workers, four on each A4 sheet.
      </Typography>
      <Actions>
        <Button variant="outlined" href="/api/templates/v1/pdf">
          Print blank tickets
        </Button>
      </Actions>
    </Step>
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
    <Typography sx={{ mt: 1 }}>
      <Link to="/review?month=none">
        {waiting === 1 ? '1 ticket waits' : `${waiting} tickets wait`} for a date.
      </Link>
    </Typography>
  );
}

/** The folded-away parts: every ticket of the month, and the spelling lists. */
function More(props: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <Accordion defaultExpanded={props.open} disableGutters sx={{ mb: 1 }}>
      <AccordionSummary
        expandIcon={
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
            <path d="M7 10l5 5 5-5z" fill="currentColor" />
          </svg>
        }
      >
        <Typography sx={{ fontWeight: 600 }}>{props.title}</Typography>
      </AccordionSummary>
      <AccordionDetails>{props.children}</AccordionDetails>
    </Accordion>
  );
}

const newest = (a: MonthSummary, b: MonthSummary) => b.year - a.year || b.month - a.month;

/** Home is the month at hand (design pass): the newest open month, step by step. */
export function Home() {
  const months = useMonths();
  const { hash } = useLocation();
  if (months.error)
    return <ErrorMessage message={months.error.message} retry={() => void months.refetch()} />;
  if (months.isPending) return <Typography>Loading the months…</Typography>;
  const open = months.data.filter((m) => m.status !== 'closed').sort(newest);
  if (open.length > 0) return <Month id={open[0]!.id} others={open.slice(1)} />;
  return (
    <Page title="This month">
      <PrintStep />
      <Step n={2} title="Upload scans">
        <Typography color="text.secondary">
          No tickets yet. Scan the filled-in tickets and upload them: Tally reads them and sorts
          them into months.
        </Typography>
        <WaitingForDate />
        <UploadsProgress />
        <Actions>
          <Button variant="contained" component={Link} to="/upload">
            Upload scans
          </Button>
        </Actions>
      </Step>
      <More title="Spelling lists" open={hash === '#lists'}>
        <Lists bare />
      </More>
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

export function Month(props: { id?: string; others?: MonthSummary[] }) {
  const params = useParams();
  const id = props.id ?? params.id;
  const { hash } = useLocation();
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
  const empty = total(m.tickets) === 0;
  return (
    <Page title={monthName(m)}>
      {props.others && props.others.length > 0 && (
        <Typography sx={{ mb: 2 }}>
          Also open:{' '}
          {props.others.map((o, i) => (
            <span key={o.id}>
              {i > 0 && ', '}
              <Link to={`/months/${o.id}`}>{monthName(o)}</Link>
              {needReview(o.tickets) > 0 && ` (${needReview(o.tickets)} to check)`}
            </span>
          ))}
        </Typography>
      )}
      <DeleteWarning m={m} />
      <PrintStep />
      <Step n={2} title="Upload scans" done={!empty && m.tickets.processing === 0}>
        <Typography color="text.secondary">
          {plural(total(m.tickets), 'ticket')} so far
          {m.tickets.processing > 0 && `, ${m.tickets.processing} still being read`}.
        </Typography>
        <UploadsProgress />
        <Actions>
          <Button variant={empty ? 'contained' : 'outlined'} component={Link} to="/upload">
            Upload scans
          </Button>
        </Actions>
      </Step>
      <Step
        n={3}
        title="Check tickets"
        done={toCheck === 0 && m.questions.length === 0 && m.tickets.processing === 0}
      >
        <Typography color="text.secondary">
          {toCheck > 0
            ? `${plural(toCheck, 'ticket')} to check. Until checked, they are left out of the downloads.`
            : m.tickets.processing > 0
              ? 'Nothing to check yet: tickets are still being read.'
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
        {props.id && <WaitingForDate />}
        <Actions>
          {toCheck > 0 && (
            // From Home, every ticket to check, those still waiting for a date included.
            <Button
              variant="contained"
              component={Link}
              to={props.id ? '/review' : `/review?month=${m.id}`}
            >
              Check next
            </Button>
          )}
          {m.questions.length > 0 && (
            <Button variant="outlined" component={Link} to="/workplaces">
              Answer workplace questions
            </Button>
          )}
        </Actions>
      </Step>
      {m.status === 'open' && (
        <Step n={4} title="Download and close the month">
          <Typography color="text.secondary">
            {plural(m.tickets.verified, 'ticket')} ready for the Excel
            {m.tickets.excluded > 0 && `; ${m.tickets.excluded} removed`}. When the month is done,
            download the files, then close it: closing deletes its tickets and scans.
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
            <Box sx={{ flexGrow: 1 }} />
            <Button
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
          {excel.error && <Alert severity="error">{excel.error.message}</Alert>}
          {pdfs.error && !pdfs.variables && <Alert severity="error">{pdfs.error.message}</Alert>}
        </Step>
      )}
      <Box sx={{ mt: 3 }}>
        <More title={`All tickets this month (${total(m.tickets)})`}>
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
        </More>
        <More title="Spelling lists" open={hash === '#lists'}>
          <Lists bare />
        </More>
      </Box>
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
    </Page>
  );
}
