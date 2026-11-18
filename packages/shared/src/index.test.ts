import { describe, expect, it } from 'vitest';
import { TEMPLATE_VERSION } from './index.js';

describe('shared package', () => {
  it('exposes the current ticket template version', () => {
    expect(TEMPLATE_VERSION).toBe('v1');
  });
});
