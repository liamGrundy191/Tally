// The review form (plan 9): the six boxes in the paper's order, then the name for the Excel.
// Keyboard (Liam, Q6): Tab moves between the flagged boxes and their checkboxes, then to
// "Correct, next"; Enter moves to the next flagged box not yet visited, and saves once every
// flagged box was visited. With nothing flagged, Enter saves.
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
  FIELD_KEYS,
  type FieldKey,
  type FlagCode,
  formatMinutes,
  hasHebrew,
  saveTicketSchema,
} from '@tally/shared';
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { Ticket, TicketDetail, TicketFlag } from '../api.ts';
import { dayOf, reason } from './flags.tsx';

export type Control = FieldKey | 'workerName';
const CONTROLS: Control[] = [...FIELD_KEYS, 'workerName'];
export const LABELS: Record<Control, string> = {
  firstName: 'First name',
  workplace: 'Workplace',
  date: 'Date (DD/MM/YY)',
  startTime: 'Start',
  endTime: 'End',
  totalWorked: 'Total',
  workerName: 'Name in English (for the Excel)',
};
export type FormValues = Record<Control, string> & { accept: Record<string, boolean> };
export type SaveBody = {
  version: number;
  values: Record<FieldKey, string | null>;
  workerName: string | null;
  accept: FlagCode[];
};

/** Doubts about a reading: a reader's guess is filled in only while one is open (D24). */
const DISPUTES: FlagCode[] = ['FIELD_UNREADABLE', 'PASS_DISAGREEMENT', 'MATCH_AMBIGUOUS'];
const TIMES: FieldKey[] = ['startTime', 'endTime', 'totalWorked'];
/** The boxes a "the paper really says this" is about: changing one asks again on save. */
const CONCERNS: Partial<Record<FlagCode, FieldKey[]>> = {
  TIME_MATH_MISMATCH: TIMES,
  HOURS_OUT_OF_RANGE: TIMES,
  DATE_TOO_OLD: ['date'],
  SCRIPT_UNEXPECTED: ['firstName'],
};

export const openFlags = (t: TicketDetail) => t.flags.filter((f) => f.resolvedAt === null);
/** The box a flag is shown at; null for the whole ticket. */
export const controlOf = (f: Pick<TicketFlag, 'code' | 'field'>): Control | null =>
  f.code === 'NAME_NOT_CONFIRMED' ? 'workerName' : f.field;
const acceptable = (fs: TicketFlag[]) =>
  fs.filter((f) => (ACCEPTABLE_FLAGS as readonly string[]).includes(f.code));

const clock = (m: number | null) => (m === null ? '' : formatMinutes(m).padStart(5, '0'));
/** The stored values as they would be typed. */
export const storedText = (t: Ticket): Record<FieldKey, string> => ({
  firstName: t.firstName ?? '',
  workplace: t.workplaceRaw ?? '',
  date: t.shiftDate ? dayOf(t.shiftDate) : '',
  startTime: clock(t.startMinutes),
  endTime: clock(t.endMinutes),
  totalWorked: clock(t.totalMinutes),
});

/**
 * What each box starts with. A disputed box with no agreed guess starts empty: filling in the
 * stored reading would pick one of the two readings (D24, D31). A time or date that does not
 * exist starts as written, so it can be corrected.
 */
export function prefill(t: TicketDetail): FormValues {
  const stored = storedText(t);
  const open = openFlags(t);
  // Only an English spelling is ever a confirmed name (5.2); anything else is asked.
  const english = t.workerName && !hasHebrew(t.workerName) ? t.workerName : '';
  const values = { workerName: english, accept: {} } as FormValues;
  for (const k of FIELD_KEYS) {
    const on = open.filter((f) => f.field === k);
    const invalid = on.find((f) => f.code === 'TIME_INVALID' || f.code === 'DATE_INVALID');
    const guess = t.suggestions?.[k];
    if (guess && on.some((f) => DISPUTES.includes(f.code))) values[k] = guess;
    else if (on.some((f) => f.code === 'FIELD_UNREADABLE' || f.code === 'PASS_DISAGREEMENT'))
      values[k] = '';
    else if (invalid) values[k] = String(invalid.detail?.value ?? '');
    else values[k] = stored[k];
  }
  return values;
}

export function TicketForm(props: {
  ticket: TicketDetail;
  /** Names for the Excel to pick from, in the order offered (5.2). */
  names: { name: string; group: string }[];
  busy: boolean;
  autoFocus: boolean;
  /** Changed by the page to put the focus back on the first flagged box. */
  refocus?: number;
  /** Settles when the save is answered, either way. */
  onSave: (body: SaveBody) => Promise<unknown>;
  onFocusField: (key: FieldKey) => void;
  onSkip: () => void;
  onReprocess: () => void;
  onRemove: () => void;
}) {
  const { ticket } = props;
  const form = useForm<FormValues>({ defaultValues: prefill(ticket) });
  const formRef = useRef<HTMLFormElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const visited = useRef(new Set<string>());
  // Two clicks in one frame would send the save twice: the page's "busy" comes a render later.
  const saving = useRef(false);
  // Design pass (T5.1): the rarer actions wait under "More".
  const [more, setMore] = useState<HTMLElement | null>(null);
  const pick = (action: () => void) => () => {
    setMore(null);
    action();
  };

  const open = openFlags(ticket);
  const manual = ticket.status === 'needs_manual_entry';
  const at = (c: Control) => open.filter((f) => controlOf(f) === c);
  // Manual entry: every box is to be typed in, so every box is a stop.
  const flagged = CONTROLS.filter((c) => manual || at(c).length > 0);
  const whole = open.filter((f) => controlOf(f) === null && f.code !== 'POSSIBLE_DUPLICATE');
  const stops = [
    ...acceptable(whole).map((f) => `a-${f.id}`),
    ...flagged.flatMap((c) => [`f-${c}`, ...acceptable(at(c)).map((f) => `a-${f.id}`)]),
  ];

  const values = form.watch();
  const stored = storedText(ticket);
  /** A box the confirmation is about was changed: the save checks it again instead. */
  const changed = (f: TicketFlag) =>
    (CONCERNS[f.code] ?? []).some((k) => (values[k] ?? '').trim() !== stored[k]);

  /**
   * Marked visited here, not by its focus event: focusing a box that already has the focus fires
   * none (StrictMode runs the effects twice, so Enter on a lone flagged box did nothing).
   */
  const focusFirst = () => {
    const first = stops[0] ?? 'f-firstName';
    document.getElementById(first)?.focus();
    visited.current.add(first);
  };

  // Only a new ticket or a new version starts the form again; answering a question does not.
  useEffect(() => {
    form.reset(prefill(ticket));
    visited.current.clear();
    if (props.autoFocus) focusFirst();
  }, [ticket.id, ticket.version]);
  useEffect(() => {
    if (props.refocus) focusFirst();
  }, [props.refocus]);

  const save = form.handleSubmit((v) => {
    const workerName = v.workerName.trim();
    if (workerName) {
      const checked = saveTicketSchema.shape.workerName.safeParse(workerName);
      if (!checked.success) {
        form.setError('workerName', { message: checked.error.issues[0]!.message });
        document.getElementById('f-workerName')?.focus();
        return;
      }
    }
    if (saving.current) return;
    saving.current = true;
    const accept = acceptable(open).filter((f) => v.accept[f.id] && !changed(f));
    void props
      .onSave({
        version: ticket.version,
        values: Object.fromEntries(FIELD_KEYS.map((k) => [k, v[k].trim() || null])) as Record<
          FieldKey,
          string | null
        >,
        // An empty name is "not confirmed yet", never an empty name.
        workerName: workerName || null,
        accept: [...new Set(accept.map((f) => f.code))],
      })
      .finally(() => (saving.current = false));
  });

  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    // Not in a dialog or the name list, which React passes up from outside the form.
    if (!formRef.current?.contains(target) || e.defaultPrevented) return;
    const here = stops
      .map((id) => document.getElementById(id) as HTMLInputElement | null)
      .filter((el): el is HTMLInputElement => el !== null && !el.disabled);
    const i = here.indexOf(target as HTMLInputElement);
    if (e.key === 'Tab') {
      // Never a trap: only from a flagged box to the next one, and from the last to Confirm.
      if (i < 0 || target.getAttribute('aria-expanded') === 'true') return;
      const next = e.shiftKey ? here[i - 1] : (here[i + 1] ?? confirmRef.current);
      if (!next) return;
      e.preventDefault();
      next.focus();
    } else if (e.key === 'Enter' && target.tagName === 'INPUT') {
      e.preventDefault();
      if (e.repeat || e.nativeEvent.isComposing || props.busy) return;
      const left = here.filter((el) => !visited.current.has(el.id));
      if (left.length === 0) return void save();
      (left.find((el) => here.indexOf(el) > i) ?? left[0]!).focus();
    }
  };

  const acceptBox = (f: TicketFlag) => {
    const locked = changed(f);
    return (
      <Controller
        key={f.id}
        name={`accept.${f.id}`}
        control={form.control}
        render={({ field }) => (
          <FormControlLabel
            label={
              locked
                ? 'Checked again when you save: the box changed'
                : f.code === 'VOIDED_TICKET'
                  ? 'It is not crossed out: keep it'
                  : 'The paper really says this'
            }
            control={
              <Checkbox
                id={`a-${f.id}`}
                checked={Boolean(field.value) && !locked}
                disabled={locked}
                onChange={(e) => field.onChange(e.target.checked)}
                onFocus={() => f.field && props.onFocusField(f.field)}
              />
            }
          />
        )}
      />
    );
  };

  /** The reasons under a box, each one read out with it. */
  const helper = (c: Control): ReactNode => {
    const lines: ReactNode[] = at(c).map((f) => <span key={f.id}>{reason(f, ticket)}. </span>);
    const guess = c !== 'workerName' && ticket.suggestions?.[c];
    if (guess && values[c] === guess && at(c).some((f) => DISPUTES.includes(f.code)))
      lines.push(<span key="guess">The best guess is filled in: check it against the scan. </span>);
    if (c === 'totalWorked' && ticket.totalFromMath && values.totalWorked === stored.totalWorked)
      lines.push(
        <span key="math">The total was unclear; it matches the start and end times. </span>,
      );
    const error = form.formState.errors[c]?.message;
    if (error) lines.push(<strong key="error">{error}</strong>);
    return lines.length ? lines : undefined;
  };
  const warn = (c: Control) =>
    flagged.includes(c)
      ? { '& .MuiOutlinedInput-notchedOutline': { borderColor: 'warning.main', borderWidth: 2 } }
      : undefined;
  // The three times sit side by side; their notes go full width below them (`below`), so a long
  // reason never wraps into a narrow column. Each note stays tied to its box for screen readers.
  const hasNote = (c: FieldKey) => helper(c) !== undefined || acceptable(at(c)).length > 0;
  const box = (c: FieldKey, below = false) => (
    <Box key={c}>
      <Controller
        name={c}
        control={form.control}
        render={({ field }) => (
          <TextField
            id={`f-${c}`}
            label={LABELS[c]}
            value={field.value}
            onChange={(e) => {
              field.onChange(e.target.value);
              // A new first name needs its English spelling confirmed again (5.2).
              if (c === 'firstName' && !form.getFieldState('workerName').isDirty)
                form.setValue('workerName', '');
            }}
            onBlur={field.onBlur}
            onFocus={() => props.onFocusField(c)}
            helperText={below ? undefined : helper(c)}
            fullWidth
            sx={warn(c)}
            slotProps={{
              htmlInput: {
                dir: 'auto',
                autoComplete: 'off',
                ...(below && hasNote(c) && { 'aria-describedby': `n-${c}` }),
              },
            }}
          />
        )}
      />
      {!below && acceptable(at(c)).map(acceptBox)}
    </Box>
  );
  const note = (c: FieldKey) =>
    hasNote(c) && (
      <Box key={c} id={`n-${c}`}>
        <Typography variant="body2" color="text.secondary">
          <strong>{LABELS[c]}:</strong> {helper(c)}
        </Typography>
        {acceptable(at(c)).map(acceptBox)}
      </Box>
    );

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(e) => void save(e)}
      onKeyDown={onKeyDown}
      onFocus={(e) => visited.current.add(e.target.id)}
    >
      <Stack spacing={2}>
        {whole.map((f) => (
          <Alert key={f.id} severity="warning">
            {reason(f, ticket)}
            {acceptable([f]).map(acceptBox)}
          </Alert>
        ))}
        {FIELD_KEYS.slice(0, 3).map((c) => box(c))}
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' },
            gap: 2,
          }}
        >
          {FIELD_KEYS.slice(3).map((c) => box(c, true))}
        </Box>
        {FIELD_KEYS.slice(3).map(note)}
        <Controller
          name="workerName"
          control={form.control}
          render={({ field }) => (
            <Autocomplete
              id="f-workerName"
              freeSolo
              options={props.names}
              groupBy={(o) => o.group}
              getOptionLabel={(o) => (typeof o === 'string' ? o : o.name)}
              // The typed text is the value, so Enter with nothing picked keeps what was typed.
              inputValue={field.value}
              onInputChange={(_, v) => field.onChange(v)}
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={LABELS.workerName}
                  helperText={helper('workerName')}
                  sx={warn('workerName')}
                  onFocus={() => props.onFocusField('firstName')}
                  slotProps={{
                    ...params.slotProps,
                    htmlInput: { ...params.slotProps.htmlInput, dir: 'auto' },
                  }}
                />
              )}
            />
          )}
        />
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
          <Button ref={confirmRef} type="submit" variant="contained" disabled={props.busy}>
            Correct, next
          </Button>
          <Button
            onClick={(e) => setMore(e.currentTarget)}
            disabled={props.busy}
            aria-haspopup="menu"
          >
            More
          </Button>
          <Menu anchorEl={more} open={more !== null} onClose={() => setMore(null)}>
            <MenuItem onClick={pick(props.onSkip)}>Skip for now</MenuItem>
            <MenuItem onClick={pick(props.onReprocess)}>Read again</MenuItem>
            <MenuItem onClick={pick(props.onRemove)} sx={{ color: 'error.main' }}>
              Remove ticket
            </MenuItem>
          </Menu>
        </Stack>
      </Stack>
    </form>
  );
}
