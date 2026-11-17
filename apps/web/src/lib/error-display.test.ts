import { describe, expect, it } from 'vitest';
import { uk } from '@/i18n/uk';
import { presentError } from './error-display';

describe('presentError', () => {
  it('replaces known Instagram diagnostics with a short explanation', () => {
    expect(
      presentError(
        '[messagebutton/unconfirmed] [branch popup_changed; menus 1]',
      ),
    ).toEqual({
      message: uk.errors.instagramChatUnavailable,
      details: '[messagebutton/unconfirmed] [branch popup_changed; menus 1]',
    });
  });

  it('explains missing composer and legacy analysis errors', () => {
    expect(presentError('[composer/timeout]')).toMatchObject({
      message: uk.errors.messageFieldMissing,
    });
    expect(presentError('ІІ: analysis.max_tokens too low')).toMatchObject({
      message: uk.errors.analysisTokenLimit,
      details: 'ІІ: analysis.max_tokens too low',
    });
  });

  it('updates the legacy Ukrainian AI spelling in other reasons', () => {
    expect(presentError('Помилка ІІ')).toEqual({
      message: 'Помилка ШІ',
      details: undefined,
    });
  });
});
