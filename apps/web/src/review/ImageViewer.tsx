// The ticket's scan: zoom, pan and rotate, with the boxes of the ticket outlined on it (plan 9).
// The slip is the scan straightened as the reader saw it, so the template's field map lines up
// with it; without corner markers there is only the whole scan, and no outlines.
import { Box, Button, Stack, Typography } from '@mui/material';
import { type FieldKey, FRAME_MM, SLIP_MM, TEMPLATE_V1 } from '@tally/shared';
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react';

/** Where a box sits on the slip, in percent of the slip's width and height. */
export function boxStyle(key: FieldKey) {
  const { box } = FIELDS.find((f) => f.key === key)!;
  const pct = (mm: number, of: number) => `${(mm / of) * 100}%`;
  return {
    left: pct(FRAME_MM.x + box.x * FRAME_MM.width, SLIP_MM.width),
    top: pct(FRAME_MM.y + box.y * FRAME_MM.height, SLIP_MM.height),
    width: pct(box.w * FRAME_MM.width, SLIP_MM.width),
    height: pct(box.h * FRAME_MM.height, SLIP_MM.height),
  };
}

const FIELDS = TEMPLATE_V1.fields;
const START = { zoom: 1, turns: 0, x: 0, y: 0 };
const STEP = 40; // px an arrow key moves the scan

export function ImageViewer(props: {
  ticketId: string;
  /** The whole scan, a link valid for 5 minutes. */
  imageUrl: string;
  flagged: FieldKey[];
  focused: FieldKey | null;
  /** The scan link expired (it lasts 5 minutes): the page asks for a new one. */
  onExpired: () => void;
}) {
  const [view, setView] = useState(START);
  const [whole, setWhole] = useState(false);
  const [noSlip, setNoSlip] = useState(false);
  const [broken, setBroken] = useState(false);
  const renewed = useRef(false);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setView(START);
    setWhole(false);
    setNoSlip(false);
    setBroken(false);
    renewed.current = false;
  }, [props.ticketId]);

  const zoom = (by: number) =>
    setView((v) => ({ ...v, zoom: Math.min(8, Math.max(0.5, v.zoom * by)) }));
  // A wheel listener React adds is passive and cannot stop the page scrolling.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);

  const slip = !whole && !noSlip;
  const keys: Record<string, () => void> = {
    '+': () => zoom(1.25),
    '=': () => zoom(1.25),
    '-': () => zoom(0.8),
    r: () => setView((v) => ({ ...v, turns: (v.turns + 1) % 4 })),
    R: () => setView((v) => ({ ...v, turns: (v.turns + 1) % 4 })),
    '0': () => setView(START),
    w: () => setWhole((w) => !w),
    W: () => setWhole((w) => !w),
    ArrowLeft: () => setView((v) => ({ ...v, x: v.x + STEP })),
    ArrowRight: () => setView((v) => ({ ...v, x: v.x - STEP })),
    ArrowUp: () => setView((v) => ({ ...v, y: v.y + STEP })),
    ArrowDown: () => setView((v) => ({ ...v, y: v.y - STEP })),
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const act = keys[e.key];
    if (!act) return;
    e.preventDefault();
    act();
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!drag.current) return;
    const { x, y } = drag.current;
    drag.current = { x: e.clientX, y: e.clientY };
    setView((v) => ({ ...v, x: v.x + e.clientX - x, y: v.y + e.clientY - y }));
  };

  return (
    <Box>
      <Box
        ref={frame}
        tabIndex={0}
        role="img"
        aria-label="Ticket scan. Plus and minus zoom, arrows move, R turns, 0 resets, W shows the whole scan"
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY };
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        sx={{
          // As much of the screen as fits, so handwriting is readable.
          height: 'min(70vh, 760px)',
          minHeight: 320,
          overflow: 'hidden',
          border: 1,
          borderColor: 'divider',
          bgcolor: 'grey.100',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'grab',
          touchAction: 'none',
          '&:focus-visible': { outline: '3px solid', outlineColor: 'primary.main' },
        }}
      >
        <Box
          sx={{ position: 'relative', width: '100%', userSelect: 'none' }}
          style={{
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom}) rotate(${view.turns * 90}deg)`,
          }}
        >
          <img
            src={slip ? `/api/tickets/${props.ticketId}/slip` : props.imageUrl}
            alt=""
            draggable={false}
            onError={() => {
              if (slip) setNoSlip(true);
              else if (renewed.current) setBroken(true);
              else {
                renewed.current = true;
                props.onExpired();
              }
            }}
            style={{ display: 'block', width: '100%' }}
          />
          {slip &&
            FIELDS.map(({ key }) => {
              const focused = props.focused === key;
              const flagged = props.flagged.includes(key);
              if (!focused && !flagged) return null;
              return (
                <Box
                  key={key}
                  data-box={key}
                  sx={{ position: 'absolute', pointerEvents: 'none' }}
                  style={{
                    ...boxStyle(key),
                    outline: focused ? '3px solid #1976d2' : '2px solid #ffb74d',
                    background: focused ? 'rgba(25, 118, 210, 0.12)' : undefined,
                  }}
                />
              );
            })}
        </Box>
      </Box>
      <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button size="small" tabIndex={-1} onClick={() => zoom(1.25)}>
          Zoom in
        </Button>
        <Button size="small" tabIndex={-1} onClick={() => zoom(0.8)}>
          Zoom out
        </Button>
        <Button size="small" tabIndex={-1} onClick={keys.r}>
          Rotate
        </Button>
        <Button size="small" tabIndex={-1} onClick={keys['0']}>
          Reset
        </Button>
        {!noSlip && (
          <Button size="small" tabIndex={-1} onClick={() => setWhole((w) => !w)}>
            {whole ? 'Show the ticket only' : 'Show the whole scan'}
          </Button>
        )}
        {broken && (
          <Typography role="alert" color="error">
            The scan could not be loaded. Reload the page to try again.
          </Typography>
        )}
        {noSlip && (
          <Typography variant="body2" color="text.secondary">
            The corner markers were not found, so this is the whole scan, without box outlines.
          </Typography>
        )}
      </Stack>
    </Box>
  );
}
