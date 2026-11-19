// Ticket template v1: physical layout and field map.
//
// Field boxes are fractions of the marker frame: (0, 0) is the centre of the top-left corner
// marker and (1, 1) the centre of the bottom-right one. Marker centres are what the image step
// finds on a scan, so crops computed from these fractions survive scaling and skew.
// The PDF generator and the cropping step both read this file, so they cannot drift apart.

import type { FieldKey } from '../rules/schemas.ts';

export const TEMPLATE_VERSION = 'v1';

/** One slip: three quarters of A4's width and a quarter of its height, four per page (D32). */
export const SLIP_MM = { width: (210 * 3) / 4, height: 297 / 4 } as const;

/**
 * Solid black corner squares, inset from the slip edge to stay clear of printer margins.
 * 6 mm saves ink and still beats a fully inked character box in the marker search (D32).
 */
export const MARKER_MM = { size: 6, inset: 6 } as const;

const markerCentre = MARKER_MM.inset + MARKER_MM.size / 2;

export const MARKER_CENTRES_MM = {
  topLeft: { x: markerCentre, y: markerCentre },
  topRight: { x: SLIP_MM.width - markerCentre, y: markerCentre },
  bottomLeft: { x: markerCentre, y: SLIP_MM.height - markerCentre },
  bottomRight: { x: SLIP_MM.width - markerCentre, y: SLIP_MM.height - markerCentre },
} as const;

/** The marker frame in millimetres from the slip's top-left corner. */
export const FRAME_MM = {
  x: markerCentre,
  y: markerCentre,
  width: SLIP_MM.width - 2 * markerCentre,
  height: SLIP_MM.height - 2 * markerCentre,
} as const;

/** One handwritten character box, and the narrow slot for a printed ':' or '/'. */
export const CELL_MM = { width: 8, height: 9 } as const;
export const SEPARATOR_MM = 4;

/** Fractions of the marker frame. */
export interface FieldBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TemplateField {
  key: FieldKey;
  labelHe: string;
  labelEn: string;
  /** One character per slot: '/' and ':' are printed separators, anything else is a box. */
  pattern: string;
  labelAbove: boolean;
  box: FieldBox;
}

export const isSeparator = (c: string) => c === '/' || c === ':';

/** Width in mm of a pattern drawn with the given cell and separator widths. */
export function patternWidthMm(pattern: string, cellMm: number, separatorMm: number): number {
  return [...pattern].reduce((sum, c) => sum + (isSeparator(c) ? separatorMm : cellMm), 0);
}

function field(
  key: FieldKey,
  labelHe: string,
  labelEn: string,
  pattern: string,
  rightMm: number,
  topMm: number,
  labelAbove = false,
): TemplateField {
  const widthMm = patternWidthMm(pattern, CELL_MM.width, SEPARATOR_MM);
  return {
    key,
    labelHe,
    labelEn,
    pattern,
    labelAbove,
    box: {
      x: (rightMm - widthMm - FRAME_MM.x) / FRAME_MM.width,
      y: (topMm - FRAME_MM.y) / FRAME_MM.height,
      w: widthMm / FRAME_MM.width,
      h: CELL_MM.height / FRAME_MM.height,
    },
  };
}

/** The printed example strip (דנה, 08:30), centred at the top. It also tells which way is up. */
export const EXAMPLE_STRIP_MM = { top: 6.5, height: 6.5 } as const;

/** The label column: labels are right-aligned to its right edge, Hebrew-style. */
export const LABELS_MM = { left: 130, right: SLIP_MM.width - 6 } as const;

/** Right edge of the box rows, just left of the label column. */
const BOXES_RIGHT_MM = LABELS_MM.left - 0.5;

/**
 * Printed boxes keep this far from the markers: the scan's contrast stretch darkens box lines,
 * and a box touching a marker merges with it so the marker is no longer found.
 */
export const MARKER_CLEARANCE_MM = 2;

/** The times row starts just clear of the bottom-left marker; labels sit above it. */
const TIME_W_MM = patternWidthMm('HH:MM', CELL_MM.width, SEPARATOR_MM);
const TIME_GAP_MM = 6;
const TOTAL_RIGHT_MM = MARKER_MM.inset + MARKER_MM.size + MARKER_CLEARANCE_MM + TIME_W_MM;

export const FIELDS: readonly TemplateField[] = [
  field('firstName', 'שם פרטי', 'First name', '_'.repeat(12), BOXES_RIGHT_MM, 15),
  field('workplace', 'מקום עבודה', 'Workplace', '_'.repeat(15), BOXES_RIGHT_MM, 25.5),
  field('date', 'תאריך', 'Date (DD/MM/YY)', 'DD/MM/YY', BOXES_RIGHT_MM, 36),
  field(
    'startTime',
    'שעת התחלה',
    'Start',
    'HH:MM',
    TOTAL_RIGHT_MM + 2 * (TIME_GAP_MM + TIME_W_MM),
    53,
    true,
  ),
  field('endTime', 'שעת סיום', 'End', 'HH:MM', TOTAL_RIGHT_MM + TIME_GAP_MM + TIME_W_MM, 53, true),
  field('totalWorked', 'סה״כ שעות', 'Total', 'HH:MM', TOTAL_RIGHT_MM, 53, true),
];

export interface TicketTemplate {
  version: string;
  fields: readonly TemplateField[];
}

export const TEMPLATE_V1: TicketTemplate = { version: TEMPLATE_VERSION, fields: FIELDS };
