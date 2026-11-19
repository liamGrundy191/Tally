// Just enough CSV for files that Excel opens and saves: quotes, CRLF, a BOM, and the ";"
// separator some Excel settings use. Not a general CSV library.

/** Parses CSV text into rows of cells. The separator is "," unless the header line has only ";". */
export function parseCsv(text: string): string[][] {
  const s = text.replace(/^\uFEFF/, '');
  const firstLine = s.split(/\r?\n/, 1)[0] ?? '';
  const sep = !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/**
 * Writes CSV that Excel opens with Hebrew intact (UTF-8 with a BOM). Ticket text is untrusted, so
 * a cell starting with = + - @ gets a leading ' and Excel shows it as text instead of running it.
 */
export function toCsv(rows: readonly (readonly (string | number | null)[])[]): string {
  const cell = (v: string | number | null) => {
    let s = v === null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Decodes a file as UTF-8, or explains how to save it from Excel when it is not. */
export function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      `${path} is not saved as UTF-8, so Hebrew would be garbled. In Excel: File → Save As → "CSV UTF-8 (Comma delimited)".`,
    );
  }
}
