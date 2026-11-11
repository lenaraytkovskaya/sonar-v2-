import { describe, expect, it } from 'vitest';
import {
  pickRegistryEntity,
  registryCodes,
  registryContacts,
  registryFacts,
  registryTerminated,
  type RegistryEntity,
} from './registry.js';
const entity = (patch: Partial<RegistryEntity>): RegistryEntity => ({
  entity_type: 'UO',
  id: '1',
  edrpou: '40123456',
  name: 'ТОВАРИСТВО З ОБМЕЖЕНОЮ ВІДПОВІДАЛЬНІСТЮ "ФАЙН АВТО"',
  short_name: 'ТОВ "ФАЙН АВТО"',
  status: 'зареєстровано',
  registration_date: '2019-04-02',
  termination_date: null,
  director: 'ПЕТРЕНКО ІВАН',
  address: 'Україна, 04136, місто Київ, вул. Некрасова, 1',
  published_at: '2026-10-01',
  ...patch,
});
describe('registry matching', () => {
  it('accepts only 8-digit codes from strings and fact objects, max three', () => {
    expect(
      registryCodes([
        '40123456',
        { code: '40 123 456', valid: true },
        '1234567',
        '3123456789',
        null,
        '40123457',
        '40123458',
        '40123459',
      ]),
    ).toEqual(['40123456', '40123457', '40123458']);
  });
  it('detects terminated statuses', () => {
    expect(registryTerminated('припинено')).toBe(true);
    expect(registryTerminated('в стані припинення')).toBe(true);
    expect(registryTerminated('зареєстровано')).toBe(false);
    expect(registryTerminated(null)).toBe(false);
  });
  it('prefers an active legal entity over branches, FOPs and terminated rows', () => {
    const picked = pickRegistryEntity([
      entity({ id: 'old', status: 'припинено' }),
      entity({ id: 'branch', entity_type: 'FSU' }),
      entity({ id: 'main' }),
    ]);
    expect(picked?.id).toBe('main');
    expect(pickRegistryEntity([])).toBeNull();
  });
  it('builds facts without empty values and caps founders', () => {
    const facts = registryFacts(entity({ termination_date: null }), [
      {
        role: 'засновник',
        name: 'ПЕТРЕНКО ІВАН',
        share: '10000',
        country: 'Україна',
      },
    ]);
    expect(facts.map((f) => f.kind)).toEqual([
      'registry_entity',
      'edrpou',
      'legal_name',
      'short_name',
      'registry_status',
      'registration_date',
      'director',
      'registered_address',
      'founders',
    ]);
    expect(facts.find((f) => f.kind === 'founders')?.value).toEqual([
      {
        role: 'засновник',
        name: 'ПЕТРЕНКО ІВАН',
        share: 10000,
        country: 'Україна',
      },
    ]);
  });
  it('maps registry contacts to phones in E.164 and valid emails only', () => {
    expect(
      registryContacts([
        {
          kind: 'phone',
          value: '(044) 338-75-18',
          normalized_value: '0443387518',
          confidence: '0.9',
        },
        {
          kind: 'email',
          value: 'Info@Fine.UA ',
          normalized_value: 'Info@Fine.UA',
          confidence: 1,
        },
        {
          kind: 'email',
          value: 'broken',
          normalized_value: 'broken',
          confidence: 1,
        },
        {
          kind: 'website',
          value: 'fine.ua',
          normalized_value: 'fine.ua',
          confidence: 1,
        },
      ]),
    ).toEqual([
      {
        kind: 'phone',
        value: '(044) 338-75-18',
        normalized: '+380443387518',
        confidence: 0.9,
      },
      {
        kind: 'email',
        value: 'Info@Fine.UA ',
        normalized: 'info@fine.ua',
        confidence: 1,
      },
    ]);
  });
});
