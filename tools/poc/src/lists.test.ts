import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkplaces } from './lists.ts';

describe('the workplace list', () => {
  it('reads two spellings of one place and names it in Hebrew, whichever side it is on', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tally-')), 'workplaces.txt');
    writeFileSync(file, '# comment\nGefen = גפן\nעינב = Einav\nבית שושנים\n=\n');
    const { list, placeOf } = loadWorkplaces(file);
    expect(list).toEqual(['Gefen', 'גפן', 'עינב', 'Einav', 'בית שושנים']);
    expect(placeOf.get('Gefen')).toBe('גפן');
    expect(placeOf.get('Einav')).toBe('עינב');
    expect(placeOf.get('בית שושנים')).toBe('בית שושנים');
  });
});
