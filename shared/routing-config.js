// shared/routing-config.js
// Single source of truth for lead-routing rules (v2 — ordered, first-match-wins rule builder).
// Pure, dependency-free ES module. Imported by worker/proxy.js, src/switch.js, src/main.js.
// No DOM / Node / Cloudflare APIs. No Date/Math.random (keep deterministic).

export const TIMELINE_BUCKETS = [
  'As soon as possible',
  'Sooner than 3 months',
  '3 to 6 months',
  '6 to 12 months',
  '1+ year',
];

export const PRICE_BUCKETS = [
  'Under $250k',
  '$250k - $500k',
  '$500k - $1M',
  '$1M - $2M',
  '$2M+',
];

const choiceList = labels => labels.map(l => ({ value: l, label: l }));

// Catalog of routable questions — values MUST match src/main.js SLIDES.
export const QUESTIONS = [
  {
    key: 'intent', payloadKey: 'intent', label: 'Looking to',
    choices: [
      { value: 'buy', label: 'Buy a home' },
      { value: 'sell', label: 'Sell a home' },
      { value: 'rent-short', label: 'Rent short-term (then buy soon)' },
      { value: 'rent-long', label: 'Rent long-term (no plans to buy)' },
    ],
  },
  { key: 'timeline', payloadKey: 'timeline', label: 'Timeline', choices: choiceList(TIMELINE_BUCKETS) },
  { key: 'price', payloadKey: 'priceRange', label: 'Price range', choices: choiceList(PRICE_BUCKETS) },
  {
    key: 'preApproval', payloadKey: 'preApproval', label: 'Pre-approval',
    choices: choiceList(['No - please connect me', 'Yes - pre-approval in hand', 'Buying with cash']),
  },
];

export const QUESTION_BY_KEY = Object.fromEntries(QUESTIONS.map(q => [q.key, q]));

export const CONFIG_VERSION = 2;

export const DEFAULT_ROUTING_CONFIG = {
  version: CONFIG_VERSION,
  rules: [
    {
      id: 'r-default-1',
      label: 'Sellers & long-term renters',
      conditions: [{ question: 'intent', anyOf: ['sell', 'rent-long'] }],
      dest: 'team',
    },
    {
      id: 'r-default-2',
      label: 'Qualified buyers & short-term renters',
      conditions: [
        { question: 'intent', anyOf: ['buy', 'rent-short'] },
        { question: 'timeline', anyOf: ['As soon as possible', 'Sooner than 3 months'] },
      ],
      dest: 'you',
    },
  ],
  fallback: 'team',
};

const cleanStr = v => (v == null ? '' : String(v).trim());
const isDest = d => d === 'you' || d === 'team';
const choiceValues = qKey => {
  const q = QUESTION_BY_KEY[qKey];
  return q ? q.choices.map(c => c.value) : null;
};

// Stable id generator (module counter — never derived from array position).
let _idSeed = 0;
export function newRuleId() {
  _idSeed += 1;
  return 'r' + _idSeed.toString(36) + 'k' + ((_idSeed * 2654435761) >>> 0).toString(36);
}

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_ROUTING_CONFIG));
}

// Coerce any stored/loaded value into a valid v2 config. Never throws.
export function normalizeConfig(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { obj = null; }
  }
  if (!obj || typeof obj !== 'object' || obj.version !== CONFIG_VERSION || !Array.isArray(obj.rules)) {
    return cloneDefault();
  }

  const usedIds = new Set();
  const rules = [];
  for (const r of obj.rules) {
    if (!r || typeof r !== 'object') continue;
    const conditions = [];
    const conds = Array.isArray(r.conditions) ? r.conditions : [];
    for (const c of conds) {
      if (!c || typeof c !== 'object') continue;
      const valid = choiceValues(c.question);
      if (!valid) continue;
      const anyOf = Array.isArray(c.anyOf) ? c.anyOf.filter(v => valid.includes(v)) : [];
      if (anyOf.length === 0) continue;
      conditions.push({ question: c.question, anyOf });
    }
    if (conditions.length === 0) continue;
    let id = typeof r.id === 'string' && r.id ? r.id : '';
    if (!id || usedIds.has(id)) { do { id = newRuleId(); } while (usedIds.has(id)); }
    usedIds.add(id);
    rules.push({
      id,
      label: typeof r.label === 'string' ? r.label : '',
      conditions,
      dest: isDest(r.dest) ? r.dest : 'team',
    });
  }

  return { version: CONFIG_VERSION, rules, fallback: isDest(obj.fallback) ? obj.fallback : 'team' };
}

// Strict validation for inbound POSTs. Returns { ok, errors }.
export function validateConfig(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['config must be an object'] };
  if (raw.version !== CONFIG_VERSION) errors.push(`version must be ${CONFIG_VERSION}`);
  if (!Array.isArray(raw.rules)) {
    errors.push('rules must be an array');
  } else {
    raw.rules.forEach((r, i) => {
      if (!r || typeof r !== 'object') { errors.push(`rule ${i} must be an object`); return; }
      if (!Array.isArray(r.conditions) || r.conditions.length === 0) {
        errors.push(`rule ${i} needs at least one condition`);
      } else {
        r.conditions.forEach((c, j) => {
          const valid = c && choiceValues(c.question);
          if (!valid) { errors.push(`rule ${i} cond ${j}: unknown question ${JSON.stringify(c && c.question)}`); return; }
          if (!Array.isArray(c.anyOf) || c.anyOf.length === 0) { errors.push(`rule ${i} cond ${j}: anyOf empty`); return; }
          for (const v of c.anyOf) if (!valid.includes(v)) errors.push(`rule ${i} cond ${j}: invalid choice ${JSON.stringify(v)}`);
        });
      }
      if (!isDest(r.dest)) errors.push(`rule ${i}: dest must be 'you' or 'team'`);
    });
  }
  if (!isDest(raw.fallback)) errors.push("fallback must be 'you' or 'team'");
  return { ok: errors.length === 0, errors };
}

function ruleMatches(rule, payload) {
  if (!rule || !Array.isArray(rule.conditions) || rule.conditions.length === 0) return false;
  for (const c of rule.conditions) {
    const q = QUESTION_BY_KEY[c.question];
    if (!q) return false;
    const answer = cleanStr(payload ? payload[q.payloadKey] : '');
    if (!Array.isArray(c.anyOf) || !c.anyOf.includes(answer)) return false;
  }
  return true;
}

// Pure routing decision. Does NOT consider overflow (worker handles that first).
export function evaluateRoute(config, payload) {
  const rules = Array.isArray(config && config.rules) ? config.rules : [];
  for (let i = 0; i < rules.length; i++) {
    if (ruleMatches(rules[i], payload)) {
      return { type: rules[i].dest === 'you' ? 'jacob' : 'team', reason: rules[i].label || ('rule ' + (i + 1)) };
    }
  }
  const fb = isDest(config && config.fallback) ? config.fallback : 'team';
  return { type: fb === 'you' ? 'jacob' : 'team', reason: 'fallback' };
}

function condMap(rule) {
  const m = new Map();
  for (const c of (rule && rule.conditions) || []) {
    const set = m.get(c.question) || new Set();
    for (const v of c.anyOf) set.add(v);
    m.set(c.question, set);
  }
  return m;
}

// Conservative (sound, not complete): true iff some earlier rule subsumes `rule`.
export function isRuleShadowed(rule, earlierRules) {
  if (!rule || !Array.isArray(rule.conditions) || rule.conditions.length === 0) return false;
  const rMap = condMap(rule);
  for (const E of earlierRules || []) {
    const eMap = condMap(E);
    let covers = true;
    for (const [q, eChoices] of eMap) {
      const rChoices = rMap.get(q);
      if (!rChoices) { covers = false; break; }
      for (const v of rChoices) if (!eChoices.has(v)) { covers = false; break; }
      if (!covers) break;
    }
    if (covers) return true;
  }
  return false;
}

// Human-readable one-liner for display/preview.
export function describeRule(rule) {
  const parts = (rule.conditions || []).map(c => {
    const q = QUESTION_BY_KEY[c.question];
    const labels = c.anyOf.map(v => {
      const ch = q && q.choices.find(x => x.value === v);
      return ch ? ch.label : v;
    });
    return `${q ? q.label : c.question}: ${labels.join(', ')}`;
  });
  return `${parts.join(' · ')} → ${rule.dest === 'you' ? 'You' : 'Team'}`;
}
