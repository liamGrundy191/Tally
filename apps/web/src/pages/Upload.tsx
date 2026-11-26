// The upload page (section 9): each file goes straight to storage on its own signed link, then is
// confirmed on its own, 3 at a time (D48). The server is the only record of what arrived.
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  FormControlLabel,
  LinearProgress,
  List,
  ListItem,
  Radio,
  RadioGroup,
  Typography,
} from '@mui/material';
import {
  MAX_UPLOAD_BYTES,
  NOT_ARRIVED,
  type ReadSpeed,
  TOO_LARGE,
  type UploadResult,
} from '@tally/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type DragEvent, useEffect, useReducer, useRef, useState } from 'react';
import { Link, useBlocker } from 'react-router';
import { api, ApiError } from '../api.ts';
import { Page } from './simple.tsx';

/** Estimated price per ticket, in cents (Q4): batch measured in Phase 0 (D38), now not yet. */
/** How a file is taken: read at a speed, or another ticket that a person types in (D68). */
type Speed = ReadSpeed | 'other';
const CENTS_PER_TICKET: Record<Speed, number> = { batch: 15, now: 30, other: 0 };
const SPEEDS: [Speed, string][] = [
  ['batch', 'Cheaper: usually ready within an hour (at most a day); about 15 cents a ticket.'],
  ['now', 'Faster: ready in minutes; about 30 cents a ticket.'],
  ['other', "Other tickets, not Tally's: not read; you type each one in from its scan. Free."],
];
const AT_ONCE = 3;
/** An upload with no progress for this long has stalled: it is stopped and can be retried. */
const STALL_MS = 60_000;
const NOT_SENT = 'The file did not upload. Check your connection and try again.';

type State = 'waiting' | 'uploading' | 'confirming' | 'done' | 'duplicate' | 'rejected' | 'failed';
interface Item {
  id: number;
  file: File;
  speed: Speed;
  state: State;
  percent: number;
  message?: string;
  pages?: number;
  /** Set once the file is in storage: a retry then only confirms it again. */
  key?: string;
  sentAgain?: boolean;
}

const active = (i: Item) => ['waiting', 'uploading', 'confirming'].includes(i.state);
const dollars = (pages: number, speed: Speed) =>
  `$${((pages * CENTS_PER_TICKET[speed]) / 100).toFixed(2)}`;

/** The upload page, or the upload panel on Home (`embedded`, D63). */
export function Upload({ embedded = false }: { embedded?: boolean }) {
  const client = useQueryClient();
  const [speed, setSpeed] = useState<Speed>('batch');
  const [, render] = useReducer((n: number) => n + 1, 0);
  // The items are changed in place and the page drawn again: the upload loop holds them.
  const items = useRef<Item[]>([]);
  const queue = useRef<Item[]>([]);
  const running = useRef(0);
  const xhrs = useRef(new Set<XMLHttpRequest>());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true; // StrictMode runs this twice
    const open = xhrs.current;
    return () => {
      alive.current = false;
      queue.current = [];
      for (const x of open) x.abort();
    };
  }, []);

  const busy = items.current.some(active);
  const blocker = useBlocker(busy);
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ''; // older browsers ask only with this
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [busy]);
  // Everything finished while "Files are still uploading" was open: nothing is lost by leaving.
  useEffect(() => {
    if (blocker.state === 'blocked' && !busy) blocker.proceed();
  }, [blocker, busy]);

  function update(item: Item, change: Partial<Item>) {
    Object.assign(item, change);
    if (alive.current) render();
  }

  function put(url: string, item: Item) {
    return new Promise<void>((resolve, reject) => {
      if (!alive.current) return reject(new Error(NOT_SENT));
      const xhr = new XMLHttpRequest();
      xhrs.current.add(xhr);
      xhr.open('PUT', url);
      let stall: ReturnType<typeof setTimeout>;
      const watch = () => {
        clearTimeout(stall);
        stall = setTimeout(() => xhr.abort(), STALL_MS);
      };
      xhr.upload.onprogress = (e) => {
        watch();
        if (e.lengthComputable) update(item, { percent: Math.floor((e.loaded * 100) / e.total) });
      };
      xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(NOT_SENT)));
      xhr.onerror = xhr.onabort = () => reject(new Error(NOT_SENT));
      xhr.onloadend = () => {
        clearTimeout(stall);
        xhrs.current.delete(xhr);
      };
      watch();
      xhr.send(item.file);
    });
  }

  async function send(item: Item): Promise<void> {
    try {
      if (!item.key) {
        update(item, { state: 'uploading', percent: 0, message: undefined });
        // One link per file, asked just before it is used: a link works for 5 minutes only.
        const [link] = await api<{ key: string; url: string }[]>('/api/uploads/sign', 'POST', {
          count: 1,
        });
        if (!alive.current) return; // the person left the page: nothing more is sent
        await put(link!.url, item);
        item.key = link!.key;
      }
      if (!alive.current) return;
      update(item, { state: 'confirming', message: undefined });
      const [result] = await api<UploadResult[]>('/api/uploads/complete', 'POST', {
        ...(item.speed === 'other' ? { freeForm: true } : { speed: item.speed }),
        files: [{ key: item.key, name: item.file.name }],
      });
      void client.invalidateQueries({ queryKey: ['progress'] });
      if (result!.status === 'queued') return update(item, { state: 'done', pages: result!.pages });
      // A retried confirm after the upload was lost (e.g. storage cleaned it up): send it again.
      if (result!.message === NOT_ARRIVED && !item.sentAgain && alive.current) {
        Object.assign(item, { key: undefined, sentAgain: true });
        return await send(item);
      }
      update(item, { state: result!.status, message: result!.message });
    } catch (e) {
      if (!alive.current) return;
      update(item, { state: 'failed', message: (e as Error).message });
      // The session ended: the page guard sends the person to log in.
      if (e instanceof ApiError && e.status === 401) client.setQueryData(['me'], null);
    }
  }

  // Started from the add and Retry handlers, never from an effect (StrictMode would run it twice).
  function pump() {
    while (alive.current && running.current < AT_ONCE && queue.current.length > 0) {
      const item = queue.current.shift()!;
      running.current++;
      void send(item).finally(() => {
        running.current--;
        pump();
      });
    }
  }

  function add(files: FileList | File[] | null) {
    for (const file of files ?? []) {
      const item: Item = { id: items.current.length, file, speed, state: 'waiting', percent: 0 };
      items.current.push(item);
      // The server judges the file type by content; only the size is known here for certain.
      if (file.size > MAX_UPLOAD_BYTES)
        Object.assign(item, { state: 'rejected', message: TOO_LARGE });
      else queue.current.push(item);
    }
    render();
    pump();
  }

  function retry(item: Item) {
    update(item, { state: 'waiting', message: undefined });
    queue.current.push(item);
    pump();
  }

  function drop(e: DragEvent) {
    e.preventDefault();
    add(e.dataTransfer.files);
  }

  const done = items.current.filter((i) => i.state === 'done');
  const pages = done.reduce((n, i) => n + i.pages!, 0);
  const cents = done.reduce((n, i) => n + i.pages! * CENTS_PER_TICKET[i.speed], 0);

  // On Home the panel brings its own heading (D63).
  const body = (
    <>
      {embedded && (
        <Typography variant="h5" component="h2">
          Upload scans
        </Typography>
      )}
      <Typography color="text.secondary" sx={{ mb: 2 }}>
        Each ticket goes to the month written on it.
      </Typography>
      <Typography component="h3" sx={{ fontWeight: 700, fontSize: '1.05rem' }}>
        How should Tally handle them?
      </Typography>
      <RadioGroup value={speed} onChange={(e) => setSpeed(e.target.value as Speed)}>
        {SPEEDS.map(([value, label]) => (
          <FormControlLabel
            key={value}
            value={value}
            control={<Radio />}
            label={label}
            disabled={busy}
          />
        ))}
      </RadioGroup>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Prices are estimates. Each page is one ticket.
      </Typography>

      <Box
        onDragOver={(e) => e.preventDefault()}
        onDrop={drop}
        sx={{
          border: '2px dashed',
          borderColor: 'divider',
          borderRadius: 1,
          p: 4,
          textAlign: 'center',
        }}
      >
        <Typography sx={{ mb: 2 }}>Drop PDF, JPEG or PNG files here, or</Typography>
        <Button variant="contained" component="label">
          Choose files
          <input
            hidden
            type="file"
            multiple
            accept=".pdf,.jpg,.jpeg,.png"
            onChange={(e) => {
              add(e.target.files);
              e.target.value = ''; // so the same files can be chosen again
            }}
          />
        </Button>
      </Box>
      {(busy || items.current.some((i) => i.state === 'failed')) && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          If the page was closed during an upload, add the same files again: the ones that already
          arrived are recognised and not read twice.
        </Typography>
      )}

      {done.length > 0 && (
        <Alert
          severity="success"
          sx={{ mt: 2 }}
          action={
            !busy && (
              <Button color="inherit" component={Link} to="/">
                Back to this month
              </Button>
            )
          }
        >
          {pages === 1 ? '1 ticket' : `${pages} tickets`}, about ${(cents / 100).toFixed(2)}.
          {!busy &&
            (done.every((i) => i.speed === 'other')
              ? ' Type them in on the check screen: you can leave this page.'
              : ' Tally is reading them: you can leave this page.')}
        </Alert>
      )}
      <List>
        {items.current.map((i) => (
          <ListItem key={i.id} disableGutters sx={{ display: 'block' }}>
            <Typography>
              <bdi>{i.file.name}</bdi>: {describe(i)}
              {i.state === 'failed' && (
                <Button size="small" sx={{ ml: 1 }} onClick={() => retry(i)}>
                  Retry
                </Button>
              )}
            </Typography>
            {i.state === 'uploading' && (
              <LinearProgress variant="determinate" value={i.percent} aria-label={i.file.name} />
            )}
          </ListItem>
        ))}
      </List>

      <Dialog open={blocker.state === 'blocked'}>
        <DialogContent>
          Files are still uploading. If you leave now, the ones not yet uploaded are lost and need
          to be added again.
        </DialogContent>
        <DialogActions>
          <Button onClick={() => blocker.reset?.()}>Stay</Button>
          <Button onClick={() => blocker.proceed?.()}>Leave</Button>
        </DialogActions>
      </Dialog>
    </>
  );
  return embedded ? body : <Page title="Upload scans">{body}</Page>;
}

function describe(i: Item) {
  switch (i.state) {
    case 'waiting':
      return 'Waiting';
    case 'uploading':
      return `Uploading: ${i.percent}%`;
    case 'confirming':
      return 'Checking the file…';
    case 'done':
      return `Uploaded: ${i.pages === 1 ? '1 page' : `${i.pages} pages`}, ${i.speed === 'other' ? 'to type in' : `about ${dollars(i.pages!, i.speed)}`}`;
    case 'failed':
      return `Failed. ${i.message}`;
    default:
      return i.message;
  }
}
