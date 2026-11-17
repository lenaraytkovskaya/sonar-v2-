import { expect, it } from 'vitest';
import { googleTypeLabel } from './google-type';

it('uses Ukrainian common Google type labels and keeps unknown codes', () => {
  expect(googleTypeLabel('car_repair')).toBe('Автосервіс');
  expect(googleTypeLabel('consultant')).toBe('Консультаційні послуги');
  expect(googleTypeLabel('unlisted_type')).toBe('unlisted_type');
  expect(googleTypeLabel(null)).toBeNull();
});
