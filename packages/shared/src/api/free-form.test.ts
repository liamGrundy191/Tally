import { describe, expect, it } from 'vitest';
import { saveFreeFormSchema, shiftHours } from '../index.ts';

describe('the hours of a shift on another ticket (D68)', () => {
  it('takes whole hours, a clock time, and quarters of an hour', () => {
    expect(shiftHours('8')).toBe(480);
    expect(shiftHours(' 7:30 ')).toBe(450);
    expect(shiftHours('7.5')).toBe(450);
    expect(shiftHours('7,50')).toBe(450);
    expect(shiftHours('7.25')).toBe(435);
    expect(shiftHours('7,75')).toBe(465);
    expect(shiftHours('12:05')).toBe(725);
  });

  it('refuses what it would have to guess, and nothing worked', () => {
    // "7.30" is often written for 7:30, but as a decimal it is 7 h 18 min.
    for (const t of ['7.30', '7.3', '7.1', '7:60', '0', '0:00', '', 'eight', '123', '-8']) {
      expect(shiftHours(t), t).toBeNull();
    }
  });

  it('needs a name, a place and at least one shift', () => {
    const ok = {
      workerName: 'Kwame',
      workplace: 'Golan Farm',
      shifts: [{ date: '02/11/26', hours: '8' }],
    };
    expect(saveFreeFormSchema.safeParse(ok).success).toBe(true);
    expect(saveFreeFormSchema.safeParse({ ...ok, shifts: [] }).success).toBe(false);
    expect(saveFreeFormSchema.safeParse({ ...ok, workplace: ' ' }).success).toBe(false);
    expect(saveFreeFormSchema.safeParse({ ...ok, workerName: 'קוואמה' }).success).toBe(false);
    // A saved shift is named with the version the person saw.
    const half = { ...ok, shifts: [{ id: crypto.randomUUID(), date: '02/11/26', hours: '8' }] };
    expect(saveFreeFormSchema.safeParse(half).success).toBe(false);
  });
});
