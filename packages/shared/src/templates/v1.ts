// Ticket template v1: physical layout and field map.
//
// Field boxes are fractions of the marker frame: (0, 0) is the centre of the top-left corner
// marker and (1, 1) the centre of the bottom-right one. Marker centres are what the image step
// finds on a scan, so crops computed from these fractions survive scaling and skew.
// The PDF generator and the cropping step both read this file, so they cannot drift apart.

import type { FieldKey } from '../rules/schemas.ts';

export const TEMPLATE_VERSION = 'v1';

/** One slip: a third of an A4 portrait page, so three print on each page. */
export const SLIP_MM = { width: 210, height: 99 } as const;

/** Solid black corner squares, inset from the slip edge to stay clear of printer margins. */
export const MARKER_MM = { size: 8, inset: 6 } as const;

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
export const CELL_MM = { width: 8.5, height: 10 } as const;
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

/** Right edge of the box rows; the labels sit to the right of it, Hebrew-style. */
const BOXES_RIGHT_MM = 165;

export const FIELDS: readonly TemplateField[] = [
  field('firstName', 'שם פרטי', 'First name', '_'.repeat(12), BOXES_RIGHT_MM, 17),
  field('workplace', 'מקום עבודה', 'Workplace', '_'.repeat(18), BOXES_RIGHT_MM, 29),
  field('date', 'תאריך', 'Date (DD/MM/YY)', 'DD/MM/YY', BOXES_RIGHT_MM, 41),
  field('startTime', 'שעת התחלה', 'Start', 'HH:MM', BOXES_RIGHT_MM, 60, true),
  field('endTime', 'שעת סיום', 'End', 'HH:MM', 115, 60, true),
  field('totalWorked', 'סה״כ שעות', 'Total', 'HH:MM', 65, 60, true),
];
