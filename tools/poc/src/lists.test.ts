import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkplaces } from './lists.ts';

describe('the workplace list', () => {
  it('reads two spellings of one place and names it in Hebrew, whichever side it is on', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tally-')), 'workplaces.txt');
    writeFileSync(file, '# comment\nGefen = גפן\nדולב = Dolev\nבית הורדים\n=\n');
    const { list, placeOf } = loadWorkplaces(file);
    expect(list).toEqual(['Gefen', 'גפן', 'דולב', 'Dolev', 'בית הורדים']);
    expect(placeOf.get('Gefen')).toBe('גפן');
    expect(placeOf.get('Dolev')).toBe('דולב');
    expect(placeOf.get('בית הורדים')).toBe('בית הורדים');
  });
});
