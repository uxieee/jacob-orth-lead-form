import { describe, it, expect } from 'vitest';
import {
  evaluateRoute, normalizeConfig, validateConfig, isRuleShadowed,
  DEFAULT_ROUTING_CONFIG, TIMELINE_BUCKETS, QUESTIONS, newRuleId,
} from './routing-config.js';

const WITHIN_90 = ['As soon as possible', 'Sooner than 3 months'];
function legacy(intent, timeline) {
  if (intent === 'rent-long' || intent === 'sell') return 'team';
  return WITHIN_90.includes(timeline) ? 'jacob' : 'team';
}

describe('default parity with v1', () => {
  for (const intent of ['buy', 'sell', 'rent-short', 'rent-long']) {
    for (const timeline of TIMELINE_BUCKETS) {
      it(`${intent} / ${timeline}`, () => {
        expect(evaluateRoute(DEFAULT_ROUTING_CONFIG, { intent, timeline }).type)
          .toBe(legacy(intent, timeline));
      });
    }
  }
});

describe('general rules + ordering', () => {
  const cfg = {
    version: 2,
    rules: [
      { id: 'a', label: 'cash', conditions: [{ question: 'preApproval', anyOf: ['Buying with cash'] }], dest: 'you' },
      { id: 'b', label: 'sellers', conditions: [{ question: 'intent', anyOf: ['sell'] }], dest: 'team' },
    ],
    fallback: 'team',
  };
  it('routes on pre-approval', () => {
    expect(evaluateRoute(cfg, { intent: 'buy', preApproval: 'Buying with cash' }).type).toBe('jacob');
  });
  it('fallback fires when nothing matches', () => {
    expect(evaluateRoute(cfg, { intent: 'buy', preApproval: 'No - please connect me' }).type).toBe('team');
  });
  it('unanswered question does not match', () => {
    expect(evaluateRoute(cfg, { intent: 'buy' }).type).toBe('team'); // no preApproval → rule a skipped
  });
  it('first match wins (order flips outcome)', () => {
    const order1 = { version: 2, fallback: 'team', rules: [
      { id: '1', conditions: [{ question: 'intent', anyOf: ['buy'] }], dest: 'you' },
      { id: '2', conditions: [{ question: 'intent', anyOf: ['buy'] }], dest: 'team' },
    ]};
    const order2 = { version: 2, fallback: 'team', rules: [order1.rules[1], order1.rules[0]] };
    expect(evaluateRoute(order1, { intent: 'buy' }).type).toBe('jacob');
    expect(evaluateRoute(order2, { intent: 'buy' }).type).toBe('team');
  });
});

describe('normalizeConfig', () => {
  it('round-trips the default object unchanged', () => {
    expect(JSON.stringify(normalizeConfig(DEFAULT_ROUTING_CONFIG)))
      .toBe(JSON.stringify(DEFAULT_ROUTING_CONFIG));
  });
  it('null / garbage / v1-shaped → default', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULT_ROUTING_CONFIG);
    expect(normalizeConfig('nope')).toEqual(DEFAULT_ROUTING_CONFIG);
    expect(normalizeConfig({ version: 1, segments: { buy: 'you' } })).toEqual(DEFAULT_ROUTING_CONFIG);
  });
  it('drops invalid conditions and choice values', () => {
    const out = normalizeConfig({ version: 2, fallback: 'team', rules: [
      { id: 'x', conditions: [
        { question: 'intent', anyOf: ['buy', 'bogus'] },
        { question: 'nope', anyOf: ['x'] },
      ], dest: 'you' },
    ]});
    expect(out.rules[0].conditions).toEqual([{ question: 'intent', anyOf: ['buy'] }]);
  });
  it('drops rules left with no valid conditions', () => {
    const out = normalizeConfig({ version: 2, fallback: 'team', rules: [
      { id: 'x', conditions: [{ question: 'intent', anyOf: ['bogus'] }], dest: 'you' },
    ]});
    expect(out.rules).toEqual([]);
  });
  it('assigns missing ids uniquely and preserves existing ids', () => {
    const out = normalizeConfig({ version: 2, fallback: 'team', rules: [
      { conditions: [{ question: 'intent', anyOf: ['buy'] }], dest: 'you' },
      { id: 'keep', conditions: [{ question: 'intent', anyOf: ['sell'] }], dest: 'team' },
    ]});
    expect(out.rules[1].id).toBe('keep');
    expect(out.rules[0].id).toBeTruthy();
    expect(out.rules[0].id).not.toBe(out.rules[1].id);
  });
  it('coerces bad dest/fallback to team; empty rules allowed', () => {
    const out = normalizeConfig({ version: 2, fallback: 'weird', rules: [
      { id: 'x', conditions: [{ question: 'intent', anyOf: ['buy'] }], dest: 'weird' },
    ]});
    expect(out.rules[0].dest).toBe('team');
    expect(out.fallback).toBe('team');
    expect(normalizeConfig({ version: 2, fallback: 'you', rules: [] }).rules).toEqual([]);
  });
});

describe('validateConfig', () => {
  const base = DEFAULT_ROUTING_CONFIG;
  it('accepts the default', () => { expect(validateConfig(base).ok).toBe(true); });
  it('rejects wrong version', () => { expect(validateConfig({ ...base, version: 1 }).ok).toBe(false); });
  it('rejects unknown question', () => {
    expect(validateConfig({ version: 2, fallback: 'team', rules: [
      { id: 'x', conditions: [{ question: 'nope', anyOf: ['a'] }], dest: 'you' }] }).ok).toBe(false);
  });
  it('rejects unknown choice value', () => {
    expect(validateConfig({ version: 2, fallback: 'team', rules: [
      { id: 'x', conditions: [{ question: 'intent', anyOf: ['banana'] }], dest: 'you' }] }).ok).toBe(false);
  });
  it('rejects empty conditions / empty anyOf / bad dest / bad fallback', () => {
    expect(validateConfig({ version: 2, fallback: 'team', rules: [{ id: 'x', conditions: [], dest: 'you' }] }).ok).toBe(false);
    expect(validateConfig({ version: 2, fallback: 'team', rules: [{ id: 'x', conditions: [{ question: 'intent', anyOf: [] }], dest: 'you' }] }).ok).toBe(false);
    expect(validateConfig({ version: 2, fallback: 'team', rules: [{ id: 'x', conditions: [{ question: 'intent', anyOf: ['buy'] }], dest: 'x' }] }).ok).toBe(false);
    expect(validateConfig({ version: 2, fallback: 'x', rules: [] }).ok).toBe(false);
  });
});

describe('isRuleShadowed', () => {
  const R = (conds) => ({ id: 'r', conditions: conds, dest: 'you' });
  it('flags subset on same question', () => {
    const e = R([{ question: 'intent', anyOf: ['buy', 'rent-short'] }]);
    const r = R([{ question: 'intent', anyOf: ['buy'] }]);
    expect(isRuleShadowed(r, [e])).toBe(true);
  });
  it('flags an extra-condition narrowing', () => {
    const e = R([{ question: 'intent', anyOf: ['buy'] }]);
    const r = R([{ question: 'intent', anyOf: ['buy'] }, { question: 'timeline', anyOf: ['As soon as possible'] }]);
    expect(isRuleShadowed(r, [e])).toBe(true);
  });
  it('does not flag disjoint or independent rules', () => {
    const e = R([{ question: 'intent', anyOf: ['buy'] }]);
    expect(isRuleShadowed(R([{ question: 'intent', anyOf: ['sell'] }]), [e])).toBe(false);
    expect(isRuleShadowed(R([{ question: 'timeline', anyOf: ['1+ year'] }]), [e])).toBe(false);
  });
});

describe('newRuleId', () => {
  it('produces distinct ids', () => {
    expect(newRuleId()).not.toBe(newRuleId());
  });
});

describe('QUESTIONS catalog matches the form', () => {
  it('has the four routable questions', () => {
    expect(QUESTIONS.map(q => q.key)).toEqual(['intent', 'timeline', 'price', 'preApproval']);
  });
});
