import './switch.css';
import {
  QUESTIONS, QUESTION_BY_KEY, DEFAULT_ROUTING_CONFIG,
  normalizeConfig, evaluateRoute, isRuleShadowed, describeRule, newRuleId,
} from '../shared/routing-config.js';

const trimTrailingSlash = v => (v || '').replace(/\/+$/, '');
const CONFIG = {
  backendUrl: trimTrailingSlash(import.meta.env.VITE_BACKEND_URL || ''),
  devMockBackend: import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEV_BACKEND_MOCK !== 'false',
};
const CONFIRM_WORDS = ['confirm', 'allow'];
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let currentMode = null;
let inFlight = false;
let pendingAction = null;                  // {kind:'switch',mode} | {kind:'config',config}
let loadedConfig = normalizeConfig(DEFAULT_ROUTING_CONFIG);
let draft = normalizeConfig(DEFAULT_ROUTING_CONFIG);   // working copy (model = source of truth)
let expandedId = null;                                 // which rule is open in edit mode (accordion)
let previewAnswers = {};                               // { payloadKey: value } for the live tester

const ICON = {
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  del: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 5l5 5M4 20l1-4L16 5l3 3L8 19z"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
};

// One-click starting points. build() returns a fresh v2 config (normalized on apply).
const PRESETS = [
  {
    id: 'default',
    name: 'Qualified buyers',
    desc: 'Buyers & short-term renters moving within 90 days come to you; sellers, long-term renters, and everyone else go to the team. (The standard setup.)',
    build: () => normalizeConfig(DEFAULT_ROUTING_CONFIG),
  },
  {
    id: 'all-buyers',
    name: 'All buyers to me',
    desc: 'Every buyer and short-term renter comes to you regardless of timeline; sellers and long-term renters go to the team.',
    build: () => ({ version: 2, fallback: 'team', rules: [
      { id: newRuleId(), label: 'Buyers & short-term renters', conditions: [{ question: 'intent', anyOf: ['buy', 'rent-short'] }], dest: 'you' },
    ] }),
  },
  {
    id: 'cash-preapproved',
    name: 'Cash & pre-approved',
    desc: 'Buyers paying cash or already pre-approved come straight to you; everyone else goes to the team.',
    build: () => ({ version: 2, fallback: 'team', rules: [
      { id: newRuleId(), label: 'Ready to buy', conditions: [
        { question: 'intent', anyOf: ['buy', 'rent-short'] },
        { question: 'preApproval', anyOf: ['Buying with cash', 'Yes - pre-approval in hand'] },
      ], dest: 'you' },
    ] }),
  },
  {
    id: 'high-value',
    name: 'High-value buyers',
    desc: 'Buyers looking at $1M and up come to you; everyone else goes to the team.',
    build: () => ({ version: 2, fallback: 'team', rules: [
      { id: newRuleId(), label: '$1M+ buyers', conditions: [
        { question: 'intent', anyOf: ['buy', 'rent-short'] },
        { question: 'price', anyOf: ['$1M - $2M', '$2M+'] },
      ], dest: 'you' },
    ] }),
  },
  {
    id: 'everything-me',
    name: 'Everything to me',
    desc: 'Every lead comes to you. Use the overflow switch above when you need the opposite.',
    build: () => ({ version: 2, fallback: 'you', rules: [] }),
  },
];

document.addEventListener('DOMContentLoaded', async () => {
  renderEditorShell();
  renderRules();
  await loadState();
  await loadRoutingConfig();

  $('toggle').addEventListener('click', requestFlip);
  $('modal-cancel').addEventListener('click', closeModal);
  $('modal-go').addEventListener('click', confirmAction);
  $('modal-input').addEventListener('input', validateConfirm);
  $('modal-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && isConfirmWord($('modal-input').value)) confirmAction();
    if (e.key === 'Escape') closeModal();
  });
  $('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });

  // help overlay
  const openHelp = () => { $('help').hidden = false; };
  const closeHelp = () => { $('help').hidden = true; };
  $('help-btn').addEventListener('click', openHelp);
  $('help-close').addEventListener('click', closeHelp);
  $('help-done').addEventListener('click', closeHelp);
  $('help').addEventListener('click', e => { if (e.target === $('help')) closeHelp(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('help').hidden) closeHelp(); });
});

function getBackendUrl() {
  if (CONFIG.backendUrl) return CONFIG.backendUrl;
  if (CONFIG.devMockBackend) return null;
  return '';
}

// ─── Overflow switch (unchanged behavior) ───
async function loadState() {
  try {
    const url = getBackendUrl();
    if (!url) { applyMode('off'); return; }
    const resp = await fetch(`${url}/api/switch`);
    const data = await resp.json();
    if (data.ok) applyMode(data.mode); else showMsg(data.error || 'Could not read switch state', true);
  } catch (e) {
    if (CONFIG.devMockBackend) applyMode('off'); else showMsg(e.message || 'Could not reach the server', true);
  }
}
function applyMode(mode) {
  currentMode = mode === 'on' ? 'on' : 'off';
  const isOn = currentMode === 'on';
  $('console').classList.toggle('is-on', isOn);
  $('mode-label').textContent = isOn ? 'Overflow — all to team' : 'Routing by your rules';
  $('mode-sub').textContent = isOn
    ? 'Every new lead is going to your team right now.'
    : 'Leads route by the rules below.';
  $('toggle-caption').innerHTML = isOn
    ? 'Switch <b>OFF</b> to route by your rules again'
    : 'Switch <b>ON</b> to send every lead to the team';
  const t = $('toggle');
  t.setAttribute('aria-checked', String(isOn));
  t.disabled = false;
  refreshOverflowBanner();
}
function refreshOverflowBanner() {
  const isOn = currentMode === 'on';
  const banner = $('overflow-banner');
  if (banner) banner.hidden = !isOn;
  const editor = $('editor');
  if (editor) editor.classList.toggle('is-paused', isOn);   // dim the rules while overflow overrides them
}

// ─── Routing config load/save ───
async function loadRoutingConfig() {
  try {
    const url = getBackendUrl();
    if (!url) { setConfig(normalizeConfig(DEFAULT_ROUTING_CONFIG)); return; }
    const resp = await fetch(`${url}/api/routing-config`);
    const data = await resp.json();
    if (data.ok) setConfig(normalizeConfig(data.config)); else showMsg(data.error || 'Could not read routing rules', true);
  } catch (e) {
    if (CONFIG.devMockBackend) setConfig(normalizeConfig(DEFAULT_ROUTING_CONFIG));
    else showMsg(e.message || 'Could not reach the server', true);
  }
}
function setConfig(cfg) {
  loadedConfig = cfg;
  draft = normalizeConfig(cfg);
  renderRules();
}

// ─── Editor shell ───
function renderEditorShell() {
  $('editor').innerHTML = `
    <div class="overflow-banner" id="overflow-banner" hidden>Overflow is ON — these rules are paused; every lead goes to the team.</div>
    <h2 class="rules__title">Who comes to you</h2>
    <p class="rules__hint">Each lead is checked against these rules from the top down. The first rule it matches decides where it goes — to you, or to your team.</p>
    <div class="presets">
      <span class="kicker-mini">Start from a preset</span>
      <div class="preset-row">
        ${PRESETS.map(p => `<button class="preset-chip" type="button" data-preset="${esc(p.id)}" title="${esc(p.desc)}">${esc(p.name)}</button>`).join('')}
      </div>
    </div>
    <div id="rules"></div>
    <button class="btn-add" id="add-rule" type="button">+ Add rule</button>
    <div class="flow-sep flow-sep--final"><span>if a lead matches none of the rules above</span></div>
    <div class="fallback-card">
      <span>Send everyone else to</span>
      ${dropdownHtml({ id: 'fallback', value: draft.fallback, cls: 'dd--inline', options: [
        { value: 'team', label: 'Team' },
        { value: 'you', label: 'You' },
      ] })}
    </div>
    <div class="preview">
      <h3 class="preview__title">Try it out</h3>
      <p class="preview__hint">Pick a sample lead's answers to see exactly where they'd go right now.</p>
      <div class="preview__inputs" id="preview-inputs"></div>
      <div class="preview__result" id="preview-result"></div>
    </div>
    <button class="btn-save" id="save-rules" type="button" disabled>Save changes</button>
  `;
  // static controls
  $('add-rule').addEventListener('click', onAddRule);
  $('save-rules').addEventListener('click', requestSave);
  $('editor').querySelector('.preset-row').addEventListener('click', e => {
    const btn = e.target.closest('[data-preset]');
    if (btn) applyPreset(btn.dataset.preset);
  });
  wireDropdowns();
  renderPreviewInputs();
}

function applyPreset(id) {
  const p = PRESETS.find(x => x.id === id);
  if (!p) return;
  draft = normalizeConfig(p.build());
  expandedId = null;
  renderRules();
  afterChange();
  showMsg(`Loaded “${p.name}” — review the rules below, then Save to apply.`);
}

// ─── Rule list rendering (model = source of truth) ───
function renderRules() {
  syncFallbackDropdown();
  const host = $('rules');
  if (!host) return;
  const sep = '<div class="flow-sep"><span>if not, check the next rule</span></div>';
  host.innerHTML = draft.rules.map((rule, idx) => ruleCardHtml(rule, idx)).join(sep)
    || '<p class="rules-empty">No rules yet — every lead uses the fallback below. Add a rule, or pick a preset.</p>';
  // wire each card via delegation
  host.querySelectorAll('.rule-card').forEach(card => wireCard(card));
  updateSaveButton();
  renderPreviewResult();
}

function destPill(dest) {
  return dest === 'you'
    ? '<span class="chip chip--you">YOU</span>'
    : '<span class="chip chip--team">TEAM</span>';
}

function moveButtons(idx, last) {
  return `<div class="rule-move">
    <button data-act="up" title="Move up" type="button" ${idx === 0 ? 'disabled' : ''}>${ICON.up}</button>
    <button data-act="down" title="Move down" type="button" ${last ? 'disabled' : ''}>${ICON.down}</button>
    <button data-act="del" class="rule-move__del" title="Delete rule" type="button">${ICON.del}</button>
  </div>`;
}

function whenSummary(rule) {
  if (!rule.conditions.length) return '<span class="when-empty">any lead</span>';
  return rule.conditions.map(c => {
    const q = QUESTION_BY_KEY[c.question];
    const vals = c.anyOf.map(v => { const ch = q.choices.find(x => x.value === v); return ch ? ch.label : v; });
    const txt = vals.length ? vals.join(', ') : '—';
    return `<span class="when-chip"><b>${esc(q.label)}:</b> ${esc(txt)}</span>`;
  }).join('<span class="when-and">and</span>');
}

function ruleCardHtml(rule, idx) {
  const shadowed = isRuleShadowed(rule, draft.rules.slice(0, idx));
  const last = idx === draft.rules.length - 1;
  const num = `<span class="rule-num">${idx + 1}</span>`;
  const shadowBadge = shadowed
    ? `<div class="rule-shadow"><span class="rule-shadow__ic">${ICON.warn}</span><span>An earlier rule already sends these leads, so this rule never runs. Move it up to use it.</span></div>`
    : '';

  // ── Read (collapsed) ──
  if (expandedId !== rule.id) {
    return `<div class="rule-card ${shadowed ? 'is-shadowed' : ''}" data-id="${rule.id}">
      <div class="rule-row" data-act="expand" role="button" tabindex="0" title="Edit this rule">
        ${num}
        <div class="rule-read">
          ${rule.label ? `<div class="rule-name">${esc(rule.label)}</div>` : ''}
          <div class="rule-when">${whenSummary(rule)}</div>
        </div>
        ${destPill(rule.dest)}
        <button class="rule-edit-btn" data-act="expand" title="Edit this rule" type="button">${ICON.edit}</button>
        ${moveButtons(idx, last)}
      </div>
      ${shadowBadge}
    </div>`;
  }

  // ── Edit (expanded) ──
  const usedQs = new Set(rule.conditions.map(c => c.question));
  const addQuestions = QUESTIONS.filter(q => !usedQs.has(q.key)).map(q => ({ value: q.key, label: q.label }));
  const condRows = rule.conditions.map(c => {
    const q = QUESTION_BY_KEY[c.question];
    const checks = q.choices.map(ch =>
      `<label class="choice"><input type="checkbox" data-act="choice" data-q="${c.question}" data-v="${esc(ch.value)}" ${c.anyOf.includes(ch.value) ? 'checked' : ''}><span>${esc(ch.label)}</span></label>`
    ).join('');
    return `<div class="cond-row">
      <div class="cond-q"><span>${esc(q.label)} is one of</span> <button class="cond-del" data-act="del-cond" data-q="${c.question}" title="Remove condition" type="button">${ICON.del}</button></div>
      <div class="cond-choices">${checks}</div>
    </div>`;
  }).join('');

  return `<div class="rule-card is-editing ${shadowed ? 'is-shadowed' : ''}" data-id="${rule.id}">
    <div class="rule-edit-head">
      ${num}
      <input class="rule-label" data-act="label" type="text" placeholder="Name this rule (optional)" value="${esc(rule.label)}">
      ${moveButtons(idx, last)}
    </div>
    <div class="rule-block">
      <span class="kicker-mini">If a lead matches</span>
      <div class="rule-conds">${condRows || '<p class="cond-empty">No conditions yet — add one below (a rule with no conditions matches every lead).</p>'}</div>
      ${addQuestions.length ? dropdownHtml({ id: 'addcond::' + rule.id, value: '', placeholder: '+ add a condition…', options: addQuestions, cls: 'dd--inline' }) : ''}
    </div>
    <div class="rule-block">
      <span class="kicker-mini">Then send</span>
      <div class="seg" role="group" aria-label="Destination">
        <button class="seg-btn seg-btn--you ${rule.dest === 'you' ? 'is-active' : ''}" data-act="dest" data-v="you" type="button">You</button>
        <button class="seg-btn seg-btn--team ${rule.dest === 'team' ? 'is-active' : ''}" data-act="dest" data-v="team" type="button">Team</button>
      </div>
    </div>
    ${shadowBadge}
    <button class="rule-done" data-act="collapse" type="button">Done</button>
  </div>`;
}

function getRule(id) { return draft.rules.find(r => r.id === id); }

function wireCard(card) {
  const id = card.getAttribute('data-id');
  card.addEventListener('change', e => {
    const act = e.target.getAttribute('data-act');
    const rule = getRule(id);
    if (!rule) return;
    if (act === 'choice') toggleChoice(rule, e.target.dataset.q, e.target.dataset.v, e.target.checked);
    else if (act === 'add-cond' && e.target.value) addCondition(rule, e.target.value);
  });
  card.addEventListener('input', e => {
    if (e.target.getAttribute('data-act') === 'label') { getRule(id).label = e.target.value; afterChange(); }
  });
  card.addEventListener('click', e => {
    const actEl = e.target.closest('[data-act]');
    if (!actEl || !card.contains(actEl)) return;
    const act = actEl.dataset.act;
    const rule = getRule(id);
    if (act === 'expand') { expandedId = expandedId === id ? null : id; renderRules(); }
    else if (act === 'collapse') { expandedId = null; renderRules(); }
    else if (act === 'up') moveRule(id, -1);
    else if (act === 'down') moveRule(id, +1);
    else if (act === 'del') { draft.rules = draft.rules.filter(r => r.id !== id); if (expandedId === id) expandedId = null; renderRules(); afterChange(); }
    else if (act === 'del-cond' && rule) removeCondition(rule, actEl.dataset.q);
    else if (act === 'dest' && rule) { rule.dest = actEl.dataset.v === 'you' ? 'you' : 'team'; renderRules(); afterChange(); }
  });
  // keyboard: Enter/Space on the collapsed read row opens it
  const row = card.querySelector('.rule-row');
  if (row) row.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expandedId = id; renderRules(); }
  });
}

function toggleChoice(rule, q, v, checked) {
  const cond = rule.conditions.find(c => c.question === q);
  if (!cond) return;
  if (checked) { if (!cond.anyOf.includes(v)) cond.anyOf.push(v); }
  else { cond.anyOf = cond.anyOf.filter(x => x !== v); }
  // A condition with zero choices is invalid → drop it.
  if (cond.anyOf.length === 0) rule.conditions = rule.conditions.filter(c => c !== cond);
  renderRules(); afterChange(false);
}
function addCondition(rule, q) {
  if (rule.conditions.some(c => c.question === q)) return;
  rule.conditions.push({ question: q, anyOf: [] }); // empty until user checks; dropped on save-normalize if left empty
  renderRules(); afterChange(false);
}
function removeCondition(rule, q) {
  rule.conditions = rule.conditions.filter(c => c.question !== q);
  renderRules(); afterChange(false);
}
function moveRule(id, delta) {
  const i = draft.rules.findIndex(r => r.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= draft.rules.length) return;
  const [r] = draft.rules.splice(i, 1);
  draft.rules.splice(j, 0, r);
  renderRules(); afterChange(false);
}
function onAddRule() {
  const id = newRuleId();
  draft.rules.push({ id, label: '', conditions: [{ question: 'intent', anyOf: [] }], dest: 'team' });
  expandedId = id;            // open the new rule for editing
  renderRules(); afterChange();
}

// afterChange(reRender=false): update dirty + preview without losing focus (used by label/input).
function afterChange() { updateSaveButton(); renderPreviewResult(); }

// ─── Themed dropdown (replaces native <select> so the open menu matches the theme) ───
function dropdownHtml({ id, value, placeholder, options, cls = '' }) {
  const current = options.find(o => o.value === value);
  const labelText = current ? current.label : (placeholder || 'Select…');
  const isPlaceholder = !current;
  return `<div class="dd ${cls}" data-dd="${esc(id)}">
    <button type="button" class="dd-btn" data-dd-toggle aria-haspopup="listbox" aria-expanded="false">
      <span class="dd-val ${isPlaceholder ? 'is-placeholder' : ''}">${esc(labelText)}</span>
      <span class="dd-chev">${ICON.chev}</span>
    </button>
    <div class="dd-menu" role="listbox" hidden>
      ${options.map(o => `<button type="button" class="dd-opt ${o.value === value ? 'is-sel' : ''}" role="option" data-dd-val="${esc(o.value)}">${esc(o.label)}</button>`).join('')}
    </div>
  </div>`;
}
function closeAllDropdowns(except) {
  document.querySelectorAll('.dd-menu:not([hidden])').forEach(m => {
    if (m === except) return;
    m.hidden = true;
    const b = m.parentElement.querySelector('[data-dd-toggle]');
    if (b) b.setAttribute('aria-expanded', 'false');
  });
}
function wireDropdowns() {
  document.addEventListener('click', e => {
    const toggle = e.target.closest('[data-dd-toggle]');
    const opt = e.target.closest('.dd-opt');
    if (toggle) {
      const menu = toggle.parentElement.querySelector('.dd-menu');
      const willOpen = menu.hidden;
      closeAllDropdowns(willOpen ? menu : null);
      menu.hidden = !willOpen;
      toggle.setAttribute('aria-expanded', String(willOpen));
      return;
    }
    if (opt) {
      const dd = opt.closest('.dd');
      closeAllDropdowns();
      onDropdownChange(dd.getAttribute('data-dd'), opt.getAttribute('data-dd-val'), dd, opt);
      return;
    }
    closeAllDropdowns();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAllDropdowns(); });
}
function onDropdownChange(id, val, dd, opt) {
  if (id === 'fallback') {
    draft.fallback = val === 'you' ? 'you' : 'team';
    syncFallbackDropdown();
    afterChange();
  } else if (id.startsWith('addcond::')) {
    const rule = getRule(id.slice('addcond::'.length));
    if (rule && val) addCondition(rule, val);   // re-renders the list
  } else if (id.startsWith('prev::')) {
    const key = id.slice('prev::'.length);
    if (val) previewAnswers[key] = val; else delete previewAnswers[key];
    dd.querySelector('.dd-val').textContent = opt.textContent;
    dd.querySelector('.dd-val').classList.toggle('is-placeholder', !val);
    dd.querySelectorAll('.dd-opt').forEach(o => o.classList.toggle('is-sel', o.dataset.ddVal === val));
    renderPreviewResult();
  }
}
function syncFallbackDropdown() {
  const dd = document.querySelector('[data-dd="fallback"]');
  if (!dd) return;
  dd.querySelector('.dd-val').textContent = draft.fallback === 'you' ? 'You' : 'Team';
  dd.querySelectorAll('.dd-opt').forEach(o => o.classList.toggle('is-sel', o.dataset.ddVal === draft.fallback));
}

// ─── Live preview ───
function renderPreviewInputs() {
  $('preview-inputs').innerHTML = QUESTIONS.map(q => {
    const options = [{ value: '', label: '— not answered —' }, ...q.choices];
    return `<div class="prev-field"><span>${esc(q.label)}</span>${dropdownHtml({
      id: 'prev::' + q.payloadKey, value: previewAnswers[q.payloadKey] || '', placeholder: '— not answered —', options,
    })}</div>`;
  }).join('');
}
function renderPreviewResult() {
  const el = $('preview-result'); if (!el) return;
  const r = evaluateRoute(draft, previewAnswers);
  const dest = r.type === 'jacob' ? 'YOU' : 'TEAM';
  el.innerHTML = `This lead &rarr; <b class="dest-${dest.toLowerCase()}">${dest}</b> <small>(${esc(r.reason)})</small>`;
}

// ─── Dirty / save ───
function isDirty() { return JSON.stringify(normalizeConfig(draft)) !== JSON.stringify(loadedConfig); }
function updateSaveButton() { const b = $('save-rules'); if (b) b.disabled = !isDirty(); }

function isConfirmWord(v) { return CONFIRM_WORDS.includes((v || '').trim().toLowerCase()); }
function requestFlip() {
  if (inFlight || !currentMode) return;
  pendingAction = { kind: 'switch', mode: currentMode === 'on' ? 'off' : 'on' };
  openModalSwitch(pendingAction.mode);
}
function requestSave() {
  if (inFlight || !isDirty()) return;
  pendingAction = { kind: 'config', config: normalizeConfig(draft) };
  openModalSave();
}
function openModalSwitch(nextMode) {
  const toOn = nextMode === 'on';
  const m = $('modal');
  m.classList.toggle('to-on', toOn); m.classList.toggle('to-off', !toOn);
  $('modal-eyebrow').textContent = toOn ? 'Turning overflow ON' : 'Turning overflow OFF';
  $('modal-title').textContent = toOn ? 'Send all leads to the team?' : 'Route by your rules again?';
  $('modal-body').textContent = toOn
    ? 'Every new lead will route to your team until you switch this back off.'
    : 'Leads will route by your rules again.';
  showModal();
}
function openModalSave() {
  const m = $('modal');
  m.classList.remove('to-on', 'to-off');
  $('modal-eyebrow').textContent = 'Update routing rules';
  $('modal-title').textContent = 'Save these routing rules?';
  $('modal-body').textContent = 'New leads will route by these rules from now on. The overflow switch still overrides everything when ON.';
  showModal();
}
function showModal() { $('modal-input').value = ''; $('modal-go').disabled = true; $('modal').hidden = false; setTimeout(() => $('modal-input').focus(), 30); }
function closeModal() { $('modal').hidden = true; pendingAction = null; }
function validateConfirm() { $('modal-go').disabled = !isConfirmWord($('modal-input').value); }
async function confirmAction() {
  if (!pendingAction || !isConfirmWord($('modal-input').value)) return;
  const a = pendingAction; closeModal();
  if (a.kind === 'switch') await doFlip(a.mode); else await doSave(a.config);
}
async function doFlip(nextMode) {
  if (inFlight) return; inFlight = true; $('toggle').disabled = true;
  applyMode(nextMode);
  try {
    const url = getBackendUrl(); if (!url) return;
    const resp = await fetch(`${url}/api/switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: nextMode }) });
    const data = await resp.json().catch(() => ({}));
    if (data.ok) applyMode(data.mode); else { await loadState(); showMsg(data.error || 'Could not flip the switch.', true); }
  } catch (e) { await loadState(); showMsg(e.message || 'Could not reach the server.', true); }
  finally { inFlight = false; $('toggle').disabled = false; }
}
async function doSave(config) {
  if (inFlight) return; inFlight = true; const b = $('save-rules'); if (b) b.disabled = true;
  try {
    const url = getBackendUrl();
    if (!url) { setConfig(config); showMsg('Saved (dev mock).'); return; }
    const resp = await fetch(`${url}/api/routing-config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }) });
    const data = await resp.json().catch(() => ({}));
    if (data.ok) { setConfig(normalizeConfig(data.config)); showMsg('Routing rules saved.'); }
    else { await loadRoutingConfig(); showMsg(data.error || 'Could not save rules.', true); }
  } catch (e) { await loadRoutingConfig(); showMsg(e.message || 'Could not reach the server.', true); }
  finally { inFlight = false; updateSaveButton(); }
}
function showMsg(msg, isErr) { const el = $('msg'); el.textContent = msg || ''; el.classList.toggle('is-err', !!isErr); }
