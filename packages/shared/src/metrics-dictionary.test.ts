import { describe, expect, it } from 'vitest';
import { METRICS, getMetric, hasMetric, metricsInGroup } from './metrics-dictionary';

describe('metric dictionary', () => {
  it('has unique keys', () => {
    const keys = METRICS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('fully describes every metric', () => {
    for (const m of METRICS) {
      expect(m.key, 'key').toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
      expect(m.label.length, `${m.key} label`).toBeGreaterThan(0);
      expect(m.formula.length, `${m.key} formula`).toBeGreaterThan(0);
      expect(['currency', 'percent', 'ratio', 'count', 'bars', 'days', 'factor', 'pips']).toContain(
        m.unit,
      );
      expect(['performance', 'risk', 'trades', 'streaks', 'costs']).toContain(m.group);
    }
  });

  it('declares a direction for every metric, or explicitly neutral', () => {
    for (const m of METRICS) {
      expect([true, false, null], `${m.key} higherIsBetter`).toContain(m.higherIsBetter);
    }
  });

  it('treats losses and costs as lower-is-better', () => {
    for (const key of ['grossLoss', 'maxDrawdown', 'maxDrawdownPct', 'commissionPaid']) {
      expect(getMetric(key).higherIsBetter, key).toBe(false);
    }
  });

  it('treats descriptive counts as neutral', () => {
    expect(getMetric('totalTrades').higherIsBetter).toBeNull();
  });

  it('groups partition the dictionary', () => {
    const groups = ['performance', 'risk', 'trades', 'streaks', 'costs'] as const;
    const total = groups.reduce((sum, g) => sum + metricsInGroup(g).length, 0);
    expect(total).toBe(METRICS.length);
  });

  it('looks metrics up by key', () => {
    expect(hasMetric('sharpe')).toBe(true);
    expect(hasMetric('nope')).toBe(false);
    expect(getMetric('profitFactor').unit).toBe('factor');
    expect(() => getMetric('nope')).toThrow(/Unknown metric/);
  });
});
