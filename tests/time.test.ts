import { describe, expect, it } from 'vitest';
import { addDays, assertTimeZone, localDay, localMidnight } from '../src/time.js';

const NY = 'America/New_York';
const ts = (iso: string) => Date.parse(iso) / 1000;

describe('time', () => {
  it('localDay: сутки по Нью-Йорку начинаются в 04:00 UTC летом и в 05:00 UTC зимой', () => {
    expect(localDay(ts('2026-10-11T03:59:59Z'), NY)).toBe('2026-10-10');
    expect(localDay(ts('2026-10-11T04:00:00Z'), NY)).toBe('2026-10-11');
    expect(localDay(ts('2026-11-03T04:59:59Z'), NY)).toBe('2026-11-02');
    expect(localDay(ts('2026-11-03T05:00:00Z'), NY)).toBe('2026-11-03');
    expect(localDay(ts('2026-10-11T23:59:59Z'), 'UTC')).toBe('2026-10-11');
  });

  it('localMidnight: полночь дня в часовом поясе, включая день перехода на зимнее время', () => {
    expect(localMidnight('2026-10-11', NY)).toBe(ts('2026-10-11T04:00:00Z'));
    expect(localMidnight('2026-11-02', NY)).toBe(ts('2026-11-02T05:00:00Z'));
    expect(localMidnight('2026-11-02', NY) - localMidnight('2026-11-01', NY)).toBe(25 * 3600); // 1 ноября — 25 часов
    expect(localMidnight('2026-09-01', 'Europe/Moscow')).toBe(ts('2026-08-31T21:00:00Z'));
    expect(localMidnight('2026-09-01', 'UTC')).toBe(ts('2026-09-01T00:00:00Z'));
  });

  it('addDays и проверка часового пояса', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(() => assertTimeZone('America/New_York')).not.toThrow();
    expect(() => assertTimeZone('Mars/Olympus')).toThrow();
  });
});
