// The review screen (plan 9): the queue of tickets that need a person, one ticket at a time, and
// the duplicate question. The queue is the server's list, oldest first; tickets skipped are
// remembered in the browser until the screen is left.
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { FLAG_CODES, type FieldKey, formatMinutes, onRate57List } from '@tally/shared';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  Link,
  Navigate,
  Outlet,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams,
} from 'react-router';
import {
  api,
  ApiError,
  type MonthDetail,
  type Ticket,
  type TicketDetail,
  type TicketFlag,
  type TicketPage,
  type TicketStatus,
  type ListEntry,
} from '../api.ts';
import { ErrorMessage } from '../pages/simple.tsx';
import { FLAG_LABELS, dayOf, reason } from './flags.tsx';
import { ImageViewer } from './ImageViewer.tsx';
import { type SaveBody, TicketForm, controlOf, openFlags } from './TicketForm.tsx';

const QUEUE: TicketStatus[] = ['needs_review', 'needs_manual_entry'];
const PAGE_SIZE = 50;

/** A ticket whose only question is about its workplace: answered on the Workplaces page (T2.4). */
const waitsForWorkplace = (flags: { code: string }[]) =>
  flags.length > 0 && flags.every((f) => f.code === 'WORKPLACE_SIMILAR');
const toReview = (t: TicketDetail) => QUEUE.includes(t.status) && !waitsForWorkplace(openFlags(t));

interface Queue {
  /** `/months/<id>/check` inside a month (D63), or `/review` (tickets with no date yet). */
  base: string;
  /** `?month=…&flag=…` (only `?flag=…` inside a month), kept from ticket to ticket. */
  search: string;
  list: (status: TicketStatus, flag?: string | null) => string;
  skipped: string[];
  skip: (id: string) => void;
  forgetSkipped: () => void;
}

/** The first ticket to review: not skipped, and not only waiting for a workplace answer. */
export async function nextTicket(queue: Pick<Queue, 'list' | 'skipped'>) {
  for (const status of QUEUE) {
    for (let page = 1; ; page++) {
      const { tickets } = await api<TicketPage>(`${queue.list(status)}&page=${page}`);
      const next = tickets.find(
        (t) => !queue.skipped.includes(t.id) && !waitsForWorkplace(t.flags),
      );
      if (next) return next.id;
      if (tickets.length < PAGE_SIZE) break;
    }
  }
  return null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The queue around every ticket: how many are left, and "Only tickets with". */
export function ReviewLayout() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [skipped, setSkipped] = useState<string[]>([]);
  // Inside a month the month is in the address; /review keeps it in the query.
  const { month: monthId } = useParams();
  const month = monthId ?? params.get('month');
  const base = monthId ? `/months/${monthId}/check` : '/review';
  const inQuery = monthId ? null : month;
  const flag = params.get('flag');
  // Design pass (T5.1): the filter is rarely needed, so it opens on request.
  const [filtering, setFiltering] = useState(flag !== null);
  const list = (status: TicketStatus, f = flag) =>
    `/api/tickets?${new URLSearchParams({ ...(month && { month }), status, ...(f && { flag: f }) })}`;
  const search = new URLSearchParams({
    ...(inQuery && { month: inQuery }),
    ...(flag && { flag }),
  }).toString();
  const asking = !flag || flag === 'WORKPLACE_SIMILAR';
  const counts = useQueries({
    queries: [
      ...QUEUE.map((s) => list(s)),
      ...(asking ? [list('needs_review', 'WORKPLACE_SIMILAR')] : []),
    ].map((path) => ({
      queryKey: ['tickets', path],
      queryFn: () => api<TicketPage>(path),
    })),
  });
  const [review, manual] = counts.map((c) => c.data?.total);
  // Counted the way the queue skips them: the workplace question is their only open flag.
  // shortcut: only the first 50 with that flag are looked at ("50+" beyond); page through if it matters.
  const similar = counts[2]?.data;
  const workplace = similar && similar.tickets.filter((t) => waitsForWorkplace(t.flags)).length;
  const more = similar && similar.total > similar.tickets.length ? '+' : '';
  const queue: Queue = {
    base,
    search: search ? `?${search}` : '',
    list,
    skipped,
    skip: (id) => setSkipped((s) => [...s, id]),
    forgetSkipped: () => setSkipped([]),
  };
  const filter = (f: string) => {
    const next = new URLSearchParams({ ...(inQuery && { month: inQuery }), ...(f && { flag: f }) });
    navigate(`${base}?${next}`);
  };

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        sx={{ mb: 3, alignItems: { md: 'center' } }}
      >
        <Typography variant="h4" component="h1">
          Check tickets
        </Typography>
        {monthId && (
          <Button component={Link} to={`/months/${monthId}`} variant="outlined">
            Back to the month
          </Button>
        )}
        <Typography role="status" sx={{ flexGrow: 1 }}>
          {review === undefined || manual === undefined ? (
            'Counting the tickets left…'
          ) : (
            <>
              {`${plural(review + manual, 'ticket')} left`}
              {month === 'none' ? ', waiting for a date' : month ? ' in this month' : ''}
              {workplace ? (
                <>
                  ; {workplace}
                  {more} of them wait for a workplace answer (
                  <Link to="/workplaces">Workplaces page</Link>)
                </>
              ) : null}
              .
            </>
          )}
        </Typography>
        {!filtering ? (
          <Button onClick={() => setFiltering(true)}>Show only some tickets</Button>
        ) : (
          <TextField
            select
            size="small"
            label="Only tickets with"
            value={flag ?? ''}
            onChange={(e) => filter(e.target.value)}
            sx={{ minWidth: 260 }}
            slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}
          >
            <MenuItem value="">All tickets</MenuItem>
            {FLAG_CODES.map((c) => (
              <MenuItem key={c} value={c}>
                {FLAG_LABELS[c]}
              </MenuItem>
            ))}
          </TextField>
        )}
      </Stack>
      {counts.find((c) => c.error) && (
        <ErrorMessage message={counts.find((c) => c.error)!.error!.message} />
      )}
      <Outlet context={queue} />
    </Box>
  );
}

/** /review: goes to the next ticket, or says nothing is left. */
export function ReviewNext() {
  const queue = useOutletContext<Queue>();
  const next = useQuery<string | null, ApiError>({
    queryKey: ['queue', queue.search, queue.skipped],
    queryFn: () => nextTicket(queue),
    gcTime: 0,
  });
  if (next.error)
    return <ErrorMessage message={next.error.message} retry={() => void next.refetch()} />;
  if (next.isPending) return <Typography>Finding the next ticket…</Typography>;
  if (next.data) return <Navigate to={`${queue.base}/${next.data}${queue.search}`} replace />;
  return (
    <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
      <Typography variant="h5" component="h2">
        Nothing left to check.
      </Typography>
      {queue.skipped.length > 0 && (
        <>
          <Typography>You skipped {plural(queue.skipped.length, 'ticket')}.</Typography>
          <Button variant="contained" onClick={queue.forgetSkipped}>
            Check the skipped tickets
          </Button>
        </>
      )}
      <Button
        component={Link}
        to={queue.base === '/review' ? '/' : queue.base.replace(/\/check$/, '')}
      >
        {queue.base === '/review' ? 'Back to Home' : 'Back to the month'}
      </Button>
    </Stack>
  );
}

/** A yes/no question; Cancel has the focus, so Enter alone never confirms it. */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  text: ReactNode;
  confirm: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  // After the dialog's own focus handling, which StrictMode runs twice and can move elsewhere.
  useEffect(() => {
    if (!props.open) return;
    const id = setTimeout(() => cancel.current?.focus());
    return () => clearTimeout(id);
  }, [props.open]);
  return (
    <Dialog open={props.open} onClose={props.onClose} aria-labelledby="confirm-title">
      <DialogTitle id="confirm-title">{props.title}</DialogTitle>
      <DialogContent>
        <DialogContentText>{props.text}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button ref={cancel} autoFocus onClick={props.onClose}>
          Cancel
        </Button>
        <Button color="error" onClick={props.onConfirm} disabled={props.busy}>
          {props.confirm}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export const REMOVE = {
  title: 'Remove this ticket?',
  text: 'It leaves the Excel and the workplace PDF. This cannot be undone.',
  confirm: 'Remove',
};
const REPROCESS = {
  title: 'Read this ticket again?',
  text: 'What you typed here is not saved, and every box is read again from the scan. Reading it costs money.',
  confirm: 'Read again',
};

/** Older first, as the server decides "the old one": created first, then page, then id. */
const byScan = (a: Ticket, b: Ticket) =>
  a.createdAt.localeCompare(b.createdAt) || a.pageIndex - b.pageIndex || a.id.localeCompare(b.id);

function Side({ ticket, label }: { ticket: Ticket; label: string }) {
  const time = (m: number | null) => (m === null ? '—' : formatMinutes(m));
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography variant="subtitle2">{label}</Typography>
      <img
        src={`/api/tickets/${ticket.id}/slip`}
        alt=""
        onError={(e) => {
          if (e.currentTarget.src !== ticket.imageUrl) e.currentTarget.src = ticket.imageUrl;
        }}
        style={{ display: 'block', width: '100%' }}
      />
      <Typography variant="body2">
        <bdi>{ticket.workerName ?? ticket.firstName ?? '—'}</bdi>,{' '}
        <bdi>{ticket.workplaceRaw ?? '—'}</bdi>, {dayOf(ticket.shiftDate)},{' '}
        {time(ticket.startMinutes)} to {time(ticket.endMinutes)}, total {time(ticket.totalMinutes)}
      </Typography>
    </Box>
  );
}

/** POSSIBLE_DUPLICATE (5.2): both tickets side by side and three answers; none is chosen for you. */
function Duplicate(props: {
  flag: TicketFlag;
  ticket: TicketDetail;
  busy: boolean;
  onAnswer: (decision: 'replace' | 'keep_both' | 'ignore') => void;
}) {
  const other = props.ticket.related.find((r) => r.id === props.flag.relatedTicketId);
  if (!other) return <Alert severity="warning">{reason(props.flag, props.ticket)}</Alert>;
  const [older, newer] = [props.ticket, other].sort(byScan) as [Ticket, Ticket];
  const mine = (t: Ticket) => (t.id === props.ticket.id ? ' (this ticket)' : '');
  const answers = [
    [
      'replace',
      'Replace the old one',
      'Removes the ticket on the left, scanned first: the new one corrects it.',
    ],
    [
      'keep_both',
      'Keep both',
      'Two shifts, or two people: then give one of them a different name.',
    ],
    [
      'ignore',
      'Ignore the new one',
      'Removes the ticket on the right, scanned later: the same ticket scanned twice.',
    ],
  ] as const;
  return (
    <Box sx={{ border: 2, borderColor: 'warning.main', borderRadius: 1, p: 2 }}>
      <Typography id={`dup-${props.flag.id}`} variant="h6" component="h2" tabIndex={-1}>
        {reason(props.flag, props.ticket)}. Is it the same shift?
      </Typography>
      <Stack direction="row" spacing={2} sx={{ my: 2 }}>
        <Side ticket={older} label={`Scanned first${mine(older)}`} />
        <Side ticket={newer} label={`Scanned later${mine(newer)}`} />
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        {answers.map(([decision, label, effect]) => (
          <Box key={decision} sx={{ flex: 1 }}>
            <Button
              variant="outlined"
              fullWidth
              disabled={props.busy}
              aria-describedby={`${decision}-${props.flag.id}`}
              onClick={() => props.onAnswer(decision)}
            >
              {label}
            </Button>
            <Typography id={`${decision}-${props.flag.id}`} variant="body2" color="text.secondary">
              {effect}
            </Typography>
          </Box>
        ))}
      </Stack>
    </Box>
  );
}

type Notice = { text: ReactNode; error?: boolean; reload?: boolean };

/** /review/:id: one ticket. */
export function ReviewTicket() {
  const { id } = useParams();
  const queue = useOutletContext<Queue>();
  const navigate = useNavigate();
  const client = useQueryClient();
  const ticket = useQuery<TicketDetail, ApiError>({
    queryKey: ['ticket', id],
    queryFn: () => api(`/api/tickets/${encodeURIComponent(id!)}`),
  });
  const t = ticket.data;
  const month = useQuery<MonthDetail, ApiError>({
    queryKey: ['months', t?.monthId],
    queryFn: () => api(`/api/months/${t!.monthId}`),
    enabled: Boolean(t?.monthId),
  });
  const names = useQuery<{ name: string }[], ApiError>({
    queryKey: ['lists', 'name'],
    queryFn: () => api('/api/lists/name'),
  });
  // The 57 list ticks the 57 box (D66); the workplace list finds a place by any of its spellings.
  const rate57 = useQuery<ListEntry[], ApiError>({
    queryKey: ['lists', 'rate57'],
    queryFn: () => api('/api/lists/rate57'),
  });
  const places = useQuery<ListEntry[], ApiError>({
    queryKey: ['lists', 'workplace'],
    queryFn: () => api('/api/lists/workplace'),
  });
  const [focused, setFocused] = useState<FieldKey | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dialog, setDialog] = useState<'remove' | 'reprocess' | null>(null);
  /** Changed to put the focus back on the first flagged box, without starting the form again. */
  const [refocus, setRefocus] = useState(0);
  useEffect(() => {
    setNotice(null);
    setDialog(null);
    setFocused(null);
  }, [id]);

  const next = () => {
    void client.invalidateQueries({ queryKey: ['tickets'] });
    void client.invalidateQueries({ queryKey: ['months'] });
    navigate(`${queue.base}${queue.search}`);
  };
  const fail = (e: Error) => {
    const status = e instanceof ApiError ? e.status : 0;
    setNotice({ text: e.message, error: true, reload: status === 409 });
    if (status === 400) void ticket.refetch();
  };
  const path = `/api/tickets/${encodeURIComponent(id!)}`;
  const save = useMutation({
    mutationFn: (body: SaveBody) => api<TicketDetail>(path, 'PUT', body),
    onSuccess: (saved) => {
      if (!toReview(saved)) return next();
      // Saved, but the checks or the organiser found something new (D46): the person stays.
      client.setQueryData(['ticket', id], saved);
      void client.invalidateQueries({ queryKey: ['tickets'] });
      const left = openFlags(saved);
      setNotice({
        text: (
          <>
            Saved. This ticket still needs:{' '}
            {left.map((f) => (
              <span key={f.id}>{reason(f, saved)}. </span>
            ))}
          </>
        ),
      });
    },
    onError: fail,
  });
  const act = useMutation({
    mutationFn: (what: 'exclude' | 'reprocess') =>
      api(`${path}/${what}`, 'POST', { version: t!.version }),
    onSuccess: next,
    onError: (e) => {
      setDialog(null);
      fail(e);
    },
  });
  const answer = useMutation({
    mutationFn: (a: { flag: string; decision: string }) =>
      api(`/api/flags/${a.flag}/resolve`, 'POST', { decision: a.decision }),
    onSuccess: async () => {
      const after = (await ticket.refetch()).data;
      if (after && !toReview(after)) return next();
      setNotice({ text: 'Answered.' });
      setRefocus((n) => n + 1);
    },
    onError: (e) => {
      fail(e);
      void ticket.refetch();
    },
  });
  const busy = save.isPending || act.isPending || answer.isPending;

  const duplicates = t ? openFlags(t).filter((f) => f.code === 'POSSIBLE_DUPLICATE') : [];
  // A new duplicate question is answered first: its panel takes the focus.
  useEffect(() => {
    if (duplicates[0]) document.getElementById(`dup-${duplicates[0].id}`)?.focus();
  }, [t?.id, t?.version, duplicates[0]?.id]);

  if (ticket.error)
    return <ErrorMessage message={ticket.error.message} retry={() => void ticket.refetch()} />;
  if (!t) return <Typography>Loading the ticket…</Typography>;
  const skip = () => {
    queue.skip(t.id);
    next();
  };
  if (t.status === 'processing' || t.status === 'excluded')
    return (
      <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
        <Typography>
          {t.status === 'processing'
            ? 'This ticket is being read again.'
            : 'This ticket was removed.'}
        </Typography>
        <Button variant="contained" onClick={skip}>
          Next ticket
        </Button>
      </Stack>
    );

  const atPlace =
    month.data?.workplaces.find((w) => w.groupId === t.workplaceGroupId)?.rows.map((r) => r.name) ??
    [];
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const offered = [
    ...atPlace.map((name) => ({ name, group: 'Used at this workplace this month' })),
    ...(names.data ?? [])
      .filter((e) => !atPlace.some((n) => same(n, e.name)))
      .map((e) => ({ name: e.name, group: 'On the names list' })),
  ];
  const flagged = [
    ...new Set(
      openFlags(t)
        .map((f) => controlOf(f))
        .map((c) => (c === 'workerName' ? 'firstName' : c))
        .filter((c): c is FieldKey => c !== null),
    ),
  ];

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '3fr 2fr' }, gap: 3 }}>
      <ImageViewer
        ticketId={t.id}
        imageUrl={t.imageUrl}
        flagged={flagged}
        focused={focused}
        onExpired={() => void ticket.refetch()}
      />
      <Stack spacing={2}>
        {/* Always there, so screen readers announce what is put in it. */}
        <Box role="status">
          {notice && !notice.error && (
            <Alert severity="info" role="none">
              {notice.text}
            </Alert>
          )}
        </Box>
        {notice?.error && (
          <Alert
            severity="error"
            action={
              notice.reload && (
                <Button
                  color="inherit"
                  onClick={() => {
                    setNotice(null);
                    void ticket.refetch();
                  }}
                >
                  Reload
                </Button>
              )
            }
          >
            {notice.text}
          </Alert>
        )}
        {duplicates.map((f) => (
          <Duplicate
            key={f.id}
            flag={f}
            ticket={t}
            busy={busy}
            onAnswer={(decision) => answer.mutate({ flag: f.id, decision })}
          />
        ))}
        <TicketForm
          ticket={t}
          names={offered}
          on57={(name, place) => onRate57List(rate57.data ?? [], places.data ?? [], name, place)}
          // Not saved before the 57 list is known: the box would be left unticked (D66).
          busy={busy || rate57.isLoading || places.isLoading}
          autoFocus={duplicates.length === 0}
          refocus={refocus}
          onSave={(body) => {
            setNotice(null);
            return save.mutateAsync(body).catch(() => undefined); // shown by onError
          }}
          onFocusField={setFocused}
          onSkip={skip}
          onReprocess={() => setDialog('reprocess')}
          onRemove={() => setDialog('remove')}
        />
      </Stack>
      <ConfirmDialog
        open={dialog !== null}
        {...(dialog === 'reprocess' ? REPROCESS : REMOVE)}
        busy={act.isPending}
        onConfirm={() => act.mutate(dialog === 'reprocess' ? 'reprocess' : 'exclude')}
        onClose={() => setDialog(null)}
      />
    </Box>
  );
}
