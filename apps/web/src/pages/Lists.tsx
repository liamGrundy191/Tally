// The lists that help reading (5.4), on the month page (section 9), and on the Workplaces page
// while no month is open (D52). One workplace list and one names list, shared by every month (D42).
import { Alert, Box, Button, Stack, TextField, Typography } from '@mui/material';
import {
  LIST_KINDS,
  type ListKind,
  MAX_LIST_ENTRIES,
  MAX_LIST_LINE,
  parseList,
} from '@tally/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { api, type ApiError, type ListEntry } from '../api.ts';
import { ConfirmDialog } from '../review/Review.tsx';
import { ErrorMessage, Page } from './simple.tsx';

const TITLES: Record<ListKind, string> = {
  workplace: 'Workplace list',
  name: 'Names list',
  rate57: '57 rate list',
};
const entries = (n: number) => `${n} ${n === 1 ? 'entry' : 'entries'}`;

/** The Spelling lists page (D63): the lists, and nothing else. */
export function ListsPage() {
  return (
    <Page title="Spelling lists">
      <Lists bare />
    </Page>
  );
}

/** `bare`: under a page heading that already names it. */
export function Lists({ bare = false }: { bare?: boolean }) {
  const here = useRef<HTMLDivElement>(null);
  const { hash } = useLocation();
  // The Workplaces page links here (#lists); the router does not scroll to it by itself.
  useEffect(() => {
    if (hash === '#lists') here.current?.scrollIntoView();
  }, [hash]);
  return (
    <Box id="lists" ref={here} sx={{ mt: bare ? 0 : 4 }}>
      {!bare && (
        <Typography variant="h5" component="h2" gutterBottom>
          Spelling lists
        </Typography>
      )}
      <Typography sx={{ mb: 2 }}>
        The names and workplaces you expect, so Tally reads them better and suggests spellings. They
        never add a worker or a workplace to the Excel. Write one entry per line. Give an entry's
        other spellings after an equals sign: the Hebrew spelling, then =, then the English (
        <code dir="ltr">עינב = Einav</code>). Or paste two columns from Excel. Lines starting with #
        are skipped. Up to {MAX_LIST_ENTRIES} entries of {MAX_LIST_LINE} characters.
      </Typography>
      {LIST_KINDS.map((kind) => (
        <ListEditor key={kind} kind={kind} />
      ))}
    </Box>
  );
}

function ListEditor({ kind }: { kind: ListKind }) {
  const client = useQueryClient();
  const list = useQuery<ListEntry[], ApiError>({
    queryKey: ['lists', kind],
    queryFn: () => api(`/api/lists/${kind}`),
  });
  /** What the person typed; null while the box shows the saved list. */
  const [draft, setDraft] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const save = useMutation({
    mutationFn: (text: string) => api<ListEntry[]>(`/api/lists/${kind}`, 'PUT', { text }),
    onSuccess: (saved) => {
      client.setQueryData(['lists', kind], saved);
      setDraft(null);
    },
    onSettled: () => setAsking(false),
  });
  if (list.error)
    return <ErrorMessage message={list.error.message} retry={() => void list.refetch()} />;
  if (!list.data) return <Typography>Loading the {TITLES[kind].toLowerCase()}…</Typography>;

  const saved = list.data;
  const text = draft ?? saved.map((e) => [e.name, ...e.spellings].join(' = ')).join('\n');
  // The server reads the text with the same parseList, so this preview is what it will save.
  const parsed = draft === null ? null : parseList(kind, draft);
  let change = '';
  let removed = 0;
  if (parsed?.ok) {
    const before = new Set(saved.map((e) => e.name));
    const after = new Map(parsed.entries.map((e) => [e.name, e.spellings]));
    const added = [...after.keys()].filter((n) => !before.has(n)).length;
    removed = [...before].filter((n) => !after.has(n)).length;
    // Other spellings dropped from entries that stay: reading no longer knows them either.
    const dropped = saved.reduce((n, e) => {
      const kept = after.get(e.name);
      return n + (kept ? e.spellings.filter((x) => !kept.includes(x)).length : 0);
    }, 0);
    change =
      after.size === 0
        ? `The list will be empty (was ${saved.length}).`
        : `${entries(after.size)} (was ${saved.length}): ${added} new, ${removed} no longer on the list` +
          (dropped > 0 ? `, ${dropped} other spelling${dropped === 1 ? '' : 's'} removed.` : '.');
  }

  return (
    <Box sx={{ mb: 3 }}>
      <Typography variant="h6" component="h3">
        {TITLES[kind]}
      </Typography>
      {kind === 'rate57' && (
        <Typography color="text.secondary">
          The workers paid at the 57 rate. One line per worker: the name in English, as in the
          Excel, then each place they work at (<code dir="ltr">Avi Cohen = משק ברזלי</code>). It
          only ticks the 57 box on the check screen for you; you decide on each ticket. Changing it
          never changes tickets already checked.
        </Typography>
      )}
      <Typography>{entries(saved.length)}.</Typography>
      <TextField
        label={TITLES[kind]}
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        multiline
        minRows={3}
        maxRows={12}
        fullWidth
        sx={{ my: 1 }}
        // Each line takes its own direction: Hebrew lines read right to left.
        slotProps={{ htmlInput: { dir: 'auto', style: { unicodeBidi: 'plaintext' } } }}
      />
      {parsed && !parsed.ok && <Alert severity="error">{parsed.problem}</Alert>}
      {change && <Typography>{change}</Typography>}
      {save.error && <Alert severity="error">{save.error.message}</Alert>}
      <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
        <Button
          variant="contained"
          disabled={!parsed?.ok || save.isPending}
          onClick={() => setAsking(true)}
        >
          Replace the list
        </Button>
        {draft !== null && <Button onClick={() => setDraft(null)}>Discard changes</Button>}
      </Stack>
      <ConfirmDialog
        open={asking}
        title={`Replace the ${TITLES[kind].toLowerCase()}?`}
        text={
          `${change} ${kind === 'rate57' ? 'Tickets already checked keep their 57 box as it is.' : 'Tickets already read are not read again.'}` +
          (kind === 'name' && removed > 0
            ? ' Names added from confirmed tickets that are not in your text will be removed.'
            : '')
        }
        confirm="Replace"
        busy={save.isPending}
        onConfirm={() => save.mutate(draft!)}
        onClose={() => setAsking(false)}
      />
    </Box>
  );
}
