import { I18nService } from './i18n.service';

describe('I18nService', () => {
  const i18n = new I18nService();

  it('falls back to English when locale is missing', () => {
    expect(i18n.resolveLocale(undefined)).toBe('en');
    expect(i18n.resolveLocale('')).toBe('en');
    expect(i18n.resolveLocale('fr-FR')).toBe('en');
  });

  it('resolves Accept-Language: es to Spanish', () => {
    expect(i18n.resolveLocale('es')).toBe('es');
    expect(i18n.resolveLocale('es-MX,es;q=0.9,en;q=0.8')).toBe('es');
  });

  it('translates a known buyer-confirm error to Spanish', () => {
    const en = 'Only the shipment buyer may confirm milestones';
    expect(i18n.translateErrorMessage(en, 'es')).toBe(
      'Solo el comprador del envío puede confirmar hitos',
    );
  });

  it('keeps English when locale is en', () => {
    const en = 'Only the shipment buyer may confirm milestones';
    expect(i18n.translateErrorMessage(en, 'en')).toBe(en);
  });
});
