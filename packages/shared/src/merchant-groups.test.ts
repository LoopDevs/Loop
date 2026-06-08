import { describe, it, expect } from 'vitest';
import type { Merchant } from './merchants.js';
import { splitMerchantName, variantLabel, groupMerchants } from './merchant-groups.js';

const m = (name: string): Merchant => ({ id: name, name, enabled: true });

describe('splitMerchantName', () => {
  it('splits "Brand - Variant"', () => {
    expect(splitMerchantName('dots.eco - Plant a Tree')).toEqual({
      group: 'dots.eco',
      variant: 'Plant a Tree',
    });
  });
  it('returns the whole name as the group when there is no " - "', () => {
    expect(splitMerchantName('Apple Canada')).toEqual({ group: 'Apple Canada' });
  });
  it('does not treat a hyphen without surrounding spaces as a separator', () => {
    expect(splitMerchantName('Coca-Cola')).toEqual({ group: 'Coca-Cola' });
  });
});

describe('variantLabel', () => {
  it('is the part after "Brand - "', () => {
    expect(variantLabel(m('dots.eco - Plant a Tree'))).toBe('Plant a Tree');
  });
  it('falls back to the full name for a base listing', () => {
    expect(variantLabel(m('Visa Prepaid'))).toBe('Visa Prepaid');
  });
});

describe('groupMerchants', () => {
  it('collapses variants under one brand group', () => {
    const groups = groupMerchants([
      m('dots.eco - Plant a Tree'),
      m('dots.eco - Buy Land'),
      m('dots.eco - Coral Reef'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ name: 'dots.eco', isGroup: true });
    expect(groups[0]!.members).toHaveLength(3);
  });

  it('groups case-insensitively but displays the most common casing', () => {
    const groups = groupMerchants([m('dots.eco - A'), m('dots.eco - B'), m('Dots.eco - C')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.name).toBe('dots.eco'); // 2 vs 1
    expect(groups[0]!.members).toHaveLength(3);
  });

  it('includes a base listing (no " - ") with its variants', () => {
    const groups = groupMerchants([m('Visa Prepaid'), m('Visa Prepaid - 12M Expiration')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.isGroup).toBe(true);
    expect(groups[0]!.members.map((x) => x.name)).toContain('Visa Prepaid');
  });

  it('leaves a single merchant ungrouped (isGroup false)', () => {
    const groups = groupMerchants([m('Greggs')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.isGroup).toBe(false);
  });

  it('keeps unrelated brands separate', () => {
    const groups = groupMerchants([m('dots.eco - A'), m('Carma - Hero'), m('Greggs')]);
    expect(groups.map((g) => g.name).sort()).toEqual(['Carma', 'Greggs', 'dots.eco']);
  });
});
