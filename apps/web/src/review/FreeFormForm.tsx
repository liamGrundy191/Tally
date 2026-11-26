// Another ticket (D68): not Tally's, so nothing was read. The person types who and where once,
// then each shift on it, its date and hours, from the scan. Each shift is saved as a ticket of
// its own, so it joins its own month and is checked like any ticket.
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  ACCEPTABLE_FLAGS,
  type FlagCode,
  SHIFT_HOURS_PROBLEM,
  formatMinutes,
  saveFreeFormSchema,
  shiftHours,
} from '@tally/shared';
import { useEffect, useRef, useState } from 'react';
import type { Shift, TicketDetail, TicketFlag } from '../api.ts';
import { dayOf, reason } from './flags.tsx';

export interface FreeFormBody {
  workerName: string;
  workplace: string;
  rate57: boolean;
  shifts: { id?: string; version?: number; date: string; hours: string; accept: FlagCode[] }[];
  remove: { id: string; version: number }[];
}

interface Line {
  key: string;
  /** The shift as saved; none for a line added here. */
  saved?: Shift;
  date: string;
  hours: string;
  accept: Record<string, boolean>;
}

/** Answered elsewhere: the duplicate panel above, and the Workplaces page. */
const ELSEWHERE: string[] = ['POSSIBLE_DUPLICATE', 'WORKPLACE_SIMILAR'];
const hoursText = (m: number | null) =>
  m === null ? '' : m % 60 === 0 ? String(m / 60) : formatMinutes(m);
const dateText = (s: Shift) =>
  s.shiftDate
    ? dayOf(s.shiftDate)
    : String(s.flags.find((f) => f.code === 'DATE_INVALID')?.detail?.value ?? '');
const asFlag = (f: Shift['flags'][number]): TicketFlag => ({ ...f, resolvedAt: null });
let lineKeys = 0;
const fromShift = (s: Shift): Line => ({
  key: s.id,
  saved: s,
  date: dateText(s),
  hours: hoursText(s.totalMinutes),
  accept: {},
});

export function FreeFormForm(props: {
  ticket: TicketDetail;
  names: { name: string; group: string }[];
  busy: boolean;
  on57: (name: string, place: string) => boolean;
  /** Settles when the save is answered, either way. */
  onSave: (body: FreeFormBody) => Promise<unknown>;
  onSkip: () => void;
  onRemove: () => void;
}) {
  const { ticket } = props;
  const editable = ticket.shifts.filter((s) => !s.readOnly);
  const shown = ticket.shifts.filter((s) => s.readOnly);
  const first = editable[0] ?? ticket.shifts[0];
  const startName = first?.workerName ?? '';
  const startPlace = first?.workplaceRaw ?? '';
  const [workerName, setWorkerName] = useState(startName);
  const [workplace, setWorkplace] = useState(startPlace);
  const [lines, setLines] = useState<Line[]>(() => editable.map(fromShift));
  const [errors, setErrors] = useState<Record<string, string>>({});
  /** The person's own click on the 57 box; null until they click it (D66). */
  const [rate57Choice, setRate57Choice] = useState<boolean | null>(null);
  const [more, setMore] = useState<HTMLElement | null>(null);
  const saving = useRef(false);

  // A new scan or a new save starts the form again from what is saved.
  const savedKey = ticket.shifts.map((s) => `${s.id}:${s.version}`).join();
  useEffect(() => {
    setWorkerName(startName);
    setWorkplace(startPlace);
    setLines(editable.map(fromShift));
    setErrors({});
    setRate57Choice(null);
    if (!startName) document.getElementById('ff-workerName')?.focus();
  }, [savedKey]);

  // The 57 box, as on a Tally ticket (D66): the list ticks it until a person saves it, or when
  // the name or place is changed here; the person's click wins over both.
  const onList = props.on57(workerName.trim(), workplace.trim());
  const moved = workerName !== startName || workplace !== startPlace;
  const firstCheck = editable.every((s) => s.rate57 === null);
  const auto = moved || firstCheck ? onList : (first?.rate57 ?? false);
  const rate57 = rate57Choice ?? auto;
  const fromList = rate57Choice === null && rate57 && onList && (moved || firstCheck);

  const change = (key: string, part: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...part } : l)));
  /** A line whose date or hours changed is checked again when saved. */
  const changed = (l: Line) =>
    !l.saved ||
    l.date.trim() !== dateText(l.saved) ||
    l.hours.trim() !== hoursText(l.saved.totalMinutes);
  const dates = lines.map((l) => l.date.trim());

  const add = () => {
    const key = `new-${lineKeys++}`;
    setLines((ls) => [...ls, { key, date: '', hours: '', accept: {} }]);
    setTimeout(() => document.getElementById(`ff-date-${key}`)?.focus());
  };

  const save = () => {
    const found: Record<string, string> = {};
    const name = saveFreeFormSchema.shape.workerName.safeParse(workerName.trim());
    if (!name.success) found.workerName = name.error.issues[0]!.message;
    if (!workplace.trim()) found.workplace = 'Type the workplace.';
    for (const l of lines) {
      if (!l.date.trim()) found[`date-${l.key}`] = 'Type the date.';
      if (shiftHours(l.hours) === null) found[`hours-${l.key}`] = SHIFT_HOURS_PROBLEM;
    }
    setErrors(found);
    const firstError = Object.keys(found)[0];
    if (firstError) return document.getElementById(`ff-${firstError}`)?.focus();
    if (saving.current) return;
    saving.current = true;
    const kept = new Set(lines.flatMap((l) => (l.saved ? [l.saved.id] : [])));
    void props
      .onSave({
        workerName: workerName.trim(),
        workplace: workplace.trim(),
        rate57,
        shifts: lines.map((l) => ({
          ...(l.saved && { id: l.saved.id, version: l.saved.version }),
          date: l.date.trim(),
          hours: l.hours.trim(),
          accept: changed(l)
            ? []
            : l
                .saved!.flags.filter((f) =>
                  (ACCEPTABLE_FLAGS as readonly string[]).includes(f.code),
                )
                .filter((f) => l.accept[f.id])
                .map((f) => f.code),
        })),
        remove: editable
          .filter((s) => !kept.has(s.id))
          .map((s) => ({ id: s.id, version: s.version })),
      })
      .finally(() => (saving.current = false));
  };

  const line = (l: Line, i: number) => {
    const warnings = (l.saved?.flags ?? []).filter((f) => !ELSEWHERE.includes(f.code));
    const twice = l.date.trim() !== '' && dates.indexOf(l.date.trim()) !== i;
    return (
      <Box
        key={l.key}
        component="fieldset"
        sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2, m: 0 }}
      >
        <Typography component="legend" variant="body2" sx={{ px: 0.5, fontWeight: 700 }}>
          Shift {i + 1}
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr auto' },
            gap: 2,
            alignItems: 'start',
          }}
        >
          <TextField
            id={`ff-date-${l.key}`}
            label="Date (DD/MM/YY)"
            value={l.date}
            onChange={(e) => change(l.key, { date: e.target.value })}
            error={Boolean(errors[`date-${l.key}`])}
            helperText={
              errors[`date-${l.key}`] ??
              (twice ? 'Another shift on this ticket has this date.' : undefined)
            }
            slotProps={{ htmlInput: { autoComplete: 'off', inputMode: 'numeric' } }}
          />
          <TextField
            id={`ff-hours-${l.key}`}
            label="Hours (8, 7:30 or 7.5)"
            value={l.hours}
            onChange={(e) => change(l.key, { hours: e.target.value })}
            error={Boolean(errors[`hours-${l.key}`])}
            helperText={errors[`hours-${l.key}`]}
            slotProps={{ htmlInput: { autoComplete: 'off', inputMode: 'decimal' } }}
          />
          <Button
            onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
            disabled={lines.length === 1 || props.busy}
            aria-label={`Remove shift ${i + 1}`}
            sx={{ mt: 1 }}
          >
            Remove
          </Button>
        </Box>
        {warnings.map((f) => {
          const acceptable = (ACCEPTABLE_FLAGS as readonly string[]).includes(f.code);
          const locked = changed(l);
          return (
            <Alert key={f.id} severity="warning" sx={{ mt: 1 }}>
              {reason(asFlag(f), ticket)}.
              {acceptable && (
                <FormControlLabel
                  sx={{ display: 'flex' }}
                  label={
                    locked
                      ? 'Checked again when you save: the shift changed'
                      : 'The paper really says this'
                  }
                  control={
                    <Checkbox
                      checked={Boolean(l.accept[f.id]) && !locked}
                      disabled={locked}
                      onChange={(e) =>
                        change(l.key, { accept: { ...l.accept, [f.id]: e.target.checked } })
                      }
                    />
                  }
                />
              )}
            </Alert>
          );
        })}
      </Box>
    );
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <Stack spacing={2}>
        <Typography color="text.secondary">
          Another ticket: type it in from the scan. One worker at one workplace; add a line for each
          shift on it.
        </Typography>
        <Autocomplete
          id="ff-workerName"
          freeSolo
          options={props.names}
          groupBy={(o) => o.group}
          getOptionLabel={(o) => (typeof o === 'string' ? o : o.name)}
          inputValue={workerName}
          onInputChange={(_, v) => setWorkerName(v)}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Name in English (for the Excel)"
              error={Boolean(errors.workerName)}
              helperText={errors.workerName}
              slotProps={{
                ...params.slotProps,
                htmlInput: { ...params.slotProps.htmlInput, dir: 'auto' },
              }}
            />
          )}
        />
        <TextField
          id="ff-workplace"
          label="Workplace"
          value={workplace}
          onChange={(e) => setWorkplace(e.target.value)}
          error={Boolean(errors.workplace)}
          helperText={errors.workplace}
          slotProps={{ htmlInput: { dir: 'auto', autoComplete: 'off' } }}
        />
        <Box>
          <FormControlLabel
            label="57 rate"
            control={
              <Checkbox
                id="ff-rate57"
                checked={rate57}
                onChange={(e) => setRate57Choice(e.target.checked)}
                slotProps={{ input: { 'aria-describedby': fromList ? 'ff-n-rate57' : undefined } }}
              />
            }
          />
          {fromList && (
            <Typography id="ff-n-rate57" variant="body2" color="text.secondary">
              On the 57 list: untick it if this is someone else.
            </Typography>
          )}
        </Box>
        {shown.map((s) => (
          <Typography key={s.id} variant="body2" color="text.secondary">
            {dayOf(s.shiftDate)}, {hoursText(s.totalMinutes)} hours:{' '}
            {s.status === 'excluded' ? 'removed' : 'in a month being closed'}.
          </Typography>
        ))}
        {lines.map(line)}
        <Box>
          <Button onClick={add} disabled={props.busy || lines.length >= 62}>
            + Add shift
          </Button>
        </Box>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
          <Button type="submit" variant="contained" disabled={props.busy}>
            Save, next
          </Button>
          <Button
            onClick={(e) => setMore(e.currentTarget)}
            disabled={props.busy}
            aria-haspopup="menu"
          >
            More
          </Button>
          <Menu anchorEl={more} open={more !== null} onClose={() => setMore(null)}>
            <MenuItem
              onClick={() => {
                setMore(null);
                props.onSkip();
              }}
            >
              Skip for now
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMore(null);
                props.onRemove();
              }}
              sx={{ color: 'error.main' }}
            >
              Remove ticket
            </MenuItem>
          </Menu>
        </Stack>
      </Stack>
    </form>
  );
}
