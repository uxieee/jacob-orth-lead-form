import { CalendarComponent } from './calendar.js';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { evaluateRoute, DEFAULT_ROUTING_CONFIG } from '../shared/routing-config.js';

const trimTrailingSlash = v => (v || '').replace(/\/+$/, '');

const CONFIG = {
  backendUrl: trimTrailingSlash(import.meta.env.VITE_BACKEND_URL || ''),
  devMockBackend: import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEV_BACKEND_MOCK !== 'false',
};

const escHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const COUNTRIES = [
  { code: 'US', flag: '\u{1F1FA}\u{1F1F8}', name: 'United States', dial: '+1', format: '(XXX) XXX-XXXX', maxDigits: 10 },
  { code: 'CA', flag: '\u{1F1E8}\u{1F1E6}', name: 'Canada', dial: '+1', format: '(XXX) XXX-XXXX', maxDigits: 10 },
  { code: 'MX', flag: '\u{1F1F2}\u{1F1FD}', name: 'Mexico', dial: '+52', format: 'XXX XXX XXXX', maxDigits: 10 },
];

const state = {
  currentSlide: null,
  history: [],
  flow: null,
  data: {},
  submissionError: '',
  partialSent: false,
  fullSubmitResult: null,
  bookingInFlight: false,
  calendarBootstrapped: false,
  calendarState: 'locked',
  submissionInFlight: false,
  selectedCountry: COUNTRIES[0],
  phoneDigits: '',
  phoneRawDigits: '',
};

const SLIDES = {
  contact: {
    id: 'contact',
    type: 'contact',
    title: "Let's Get Started",
    subtitle: 'Tell us a bit about yourself',
  },
  intent: {
    id: 'intent',
    type: 'choice',
    field: 'intent',
    title: 'Are you looking to buy, sell, or rent?',
    subtitle: 'Select one option',
    options: [
      { label: 'Buy a home', value: 'buy' },
      { label: 'Sell a home', value: 'sell' },
      { label: 'Rent short-term (then buy soon)', value: 'rent-short' },
      { label: 'Rent long-term (no plans to buy)', value: 'rent-long' },
    ],
    next: value => {
      if (value === 'buy' || value === 'rent-short') return 'timeline';
      if (value === 'sell') return 'timeline-sell';
      if (value === 'rent-long') return null;
      return 'timeline';
    },
  },
  timeline: {
    id: 'timeline',
    type: 'choice',
    field: 'timeline',
    title: 'When would you like to move?',
    subtitle: 'Select one option',
    options: [
      { label: 'As soon as possible', value: 'As soon as possible' },
      { label: 'Sooner than 3 months', value: 'Sooner than 3 months' },
      { label: '3 to 6 months', value: '3 to 6 months' },
      { label: '6 to 12 months', value: '6 to 12 months' },
      { label: '1+ year', value: '1+ year' },
    ],
    next: () => 'price',
  },
  'timeline-sell': {
    id: 'timeline-sell',
    type: 'choice',
    field: 'timeline',
    title: 'When would you like to sell?',
    subtitle: 'Select one option',
    options: [
      { label: 'As soon as possible', value: 'As soon as possible' },
      { label: 'Sooner than 3 months', value: 'Sooner than 3 months' },
      { label: '3 to 6 months', value: '3 to 6 months' },
      { label: '6 to 12 months', value: '6 to 12 months' },
      { label: '1+ year', value: '1+ year' },
    ],
    next: () => 'address',
  },
  price: {
    id: 'price',
    type: 'choice',
    field: 'priceRange',
    title: "What's your ideal price range?",
    subtitle: 'Select one option',
    options: [
      { label: 'Under $250k', value: 'Under $250k' },
      { label: '$250k - $500k', value: '$250k - $500k' },
      { label: '$500k - $1M', value: '$500k - $1M' },
      { label: '$1M - $2M', value: '$1M - $2M' },
      { label: '$2M+', value: '$2M+' },
    ],
    next: () => 'preapproval',
  },
  preapproval: {
    id: 'preapproval',
    type: 'choice',
    field: 'preApproval',
    title: 'Do you have a pre-approval letter?',
    subtitle: 'Select one option',
    options: [
      { label: 'No - please connect me', value: 'No - please connect me' },
      { label: 'Yes - pre-approval in hand', value: 'Yes - pre-approval in hand' },
      { label: 'Buying with cash', value: 'Buying with cash' },
    ],
    submitLabel: 'Continue →',
    // Short-term renters get the buy-timeline question first: their move date is a rental
    // date, not a purchase date, so it cannot be used to judge how ready they are to buy.
    next: () => (state.flow === 'rent-short' ? 'buy-timeline' : 'origin'),
  },
  'buy-timeline': {
    id: 'buy-timeline',
    type: 'choice',
    field: 'buyTimeline',
    title: 'And when do you plan to buy?',
    subtitle: 'Separate from when you need the rental',
    options: [
      { label: 'As soon as possible', value: 'As soon as possible' },
      { label: 'Sooner than 3 months', value: 'Sooner than 3 months' },
      { label: '3 to 6 months', value: '3 to 6 months' },
      { label: '6 to 12 months', value: '6 to 12 months' },
      { label: '1+ year', value: '1+ year' },
    ],
    next: () => 'origin',
  },
  origin: {
    id: 'origin',
    type: 'choice',
    field: 'movingFrom',
    title: 'Where are you moving from?',
    subtitle: 'Select one option',
    options: [
      { label: 'California', value: 'California' },
      { label: 'Another U.S. state', value: 'Another U.S. state' },
      { label: "I'm already in the Las Vegas area", value: 'Already in the Las Vegas area' },
      { label: 'Outside the U.S.', value: 'Outside the U.S.' },
    ],
    next: () => 'comments',
  },
  address: {
    id: 'address',
    type: 'address',
    field: 'propertyAddress',
    title: 'Where is your property located?',
    subtitle: 'Search for your property address',
    placeholder: 'Start typing address...',
    submitLabel: 'Continue →',
    next: () => 'comments',
  },
  comments: {
    id: 'comments',
    type: 'comments',
    title: 'Anything else we should know?',
    subtitle: 'Optional — add anything that helps the team help you',
  },
  calendar: {
    id: 'calendar',
    type: 'calendar',
    title: 'Book Your Free Consultation',
    subtitle: 'Pick a date and time that works for you',
  },
  'thank-you': {
    id: 'thank-you',
    type: 'thank-you',
    title: 'Thank You',
    subtitle: '',
  },
};

const $ = id => document.getElementById(id);
let calendar = null;
let addressSearchTimer = null;
let addressLookupRequestId = 0;

// ─── Init ───
document.addEventListener('DOMContentLoaded', () => {
  navigateTo('contact');
  populateCalendarGraphic();

  calendar = new CalendarComponent($('calendar-container'), {
    proxyUrl: getBackendBaseUrl(),
    calendarId: '',
    onBook: async slot => {
      if (state.bookingInFlight) return;
      state.data.bookedSlot = slot;
      clearSubmissionError();
      state.bookingInFlight = true;

      try {
        const result = state.fullSubmitResult || {};
        const bookingPayload = {
          calendarId: result.route?.calendarId || '',
          contactId: result.contactId || state.data.contactId || '',
          opportunityId: result.opportunityId || state.data.opportunityId || '',
          bookedSlot: state.data.bookedSlot,
          firstName: state.data.firstName || '',
          lastName: state.data.lastName || '',
          email: state.data.email || '',
          phone: state.data.phone || '',
        };

        const bookingResult = await postToBackend('/api/appointments/book', bookingPayload);
        if (!bookingResult.ok) throw new Error(bookingResult.error || 'Could not book this slot.');

        navigateTo('thank-you');
      } catch (error) {
        setSubmissionError(error?.message || 'Could not book this slot. Please pick another available time.');
        if (calendar) await calendar.refreshAvailability({ preserveDate: true, clearSelectedSlot: true });
      } finally {
        state.bookingInFlight = false;
      }
    },
  });

  document.addEventListener('click', event => {
    if (!event.target.closest('.country-picker-btn') && !event.target.closest('.country-dropdown')) {
      const d = document.querySelector('.country-dropdown');
      if (d) d.classList.remove('open');
    }
    if (!event.target.closest('.address-input-wrapper')) {
      const r = document.querySelector('.address-results');
      if (r) r.classList.remove('open');
    }
  });

  const lockOverlay = $('calendar-lock-overlay');
  if (lockOverlay) {
    lockOverlay.addEventListener('click', () => {
      if (state.calendarState !== 'locked') return;
      const lockIcon = $('lock-icon');
      if (!lockIcon) return;
      lockIcon.classList.remove('shake');
      void lockIcon.offsetWidth;
      lockIcon.classList.add('shake');
    });
  }

  const calendarFocusBack = $('calendar-focus-back');
  if (calendarFocusBack) {
    calendarFocusBack.addEventListener('click', () => window.goBack());
  }
});

// ─── Mock Backend ───
function getBackendBaseUrl() {
  if (CONFIG.backendUrl) return CONFIG.backendUrl;
  if (CONFIG.devMockBackend) return null;
  return '';
}

async function postToBackend(path, payload) {
  const baseUrl = getBackendBaseUrl();
  if (!baseUrl) return mockBackendResponse(path, payload);

  const resp = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, ...data };
}

function mockBackendResponse(path, payload) {
  if (path === '/api/submit/partial') {
    const id = 'mock_' + Date.now();
    return Promise.resolve({
      ok: true, contactId: `contact_${id}`, opportunityId: `opp_${id}`,
    });
  }
  if (path === '/api/submit/full') {
    const decision = evaluateRoute(DEFAULT_ROUTING_CONFIG, {
      intent: cleanString(payload?.intent),
      timeline: payload?.timeline,
      priceRange: payload?.priceRange,
      preApproval: payload?.preApproval,
    });
    const routeType = decision.type; // 'jacob' | 'team'

    const id = payload?.contactId || 'mock_' + Date.now();
    return Promise.resolve({
      ok: true,
      contactId: id,
      opportunityId: payload?.opportunityId || `opp_${id}`,
      route: {
        type: routeType,
        calendarId: routeType === 'jacob' ? 'mock_cal_ihPuGwHD3lLJkey3WCEE' : null,
        teamHandoffUrl: routeType === 'team' ? '' : null,
        reason: decision.reason,
      },
    });
  }
  if (path === '/api/appointments/book') {
    return Promise.resolve({
      ok: true,
      message: 'Appointment booked (mock)',
      contactId: payload?.contactId || '',
      opportunityId: payload?.opportunityId || '',
      appointmentId: 'mock_appt_' + Date.now(),
    });
  }
  return Promise.resolve({ ok: false, error: 'Mock not implemented for ' + path });
}

async function fetchFromBackend(path) {
  const baseUrl = getBackendBaseUrl();
  if (!baseUrl) return mockFetchResponse(path);

  const resp = await fetch(`${baseUrl}${path}`);
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, ...data };
}

function mockFetchResponse(path) {
  if (path.startsWith('/api/free-slots')) {
    const slots = {};
    const now = new Date();
    for (let i = 0; i < 30; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const entries = [];
      for (let h = 9; h < 17; h++) {
        const s = new Date(d); s.setHours(h, 0, 0, 0);
        const e = new Date(s); e.setMinutes(30);
        entries.push({ startTime: s.toISOString(), endTime: e.toISOString() });
      }
      slots[key] = entries;
    }
    return Promise.resolve(slots);
  }
  if (path.startsWith('/api/address/autocomplete')) {
    return Promise.resolve({ type: 'FeatureCollection', features: [] });
  }
  if (path === '/api/switch') {
    return Promise.resolve({ ok: true, mode: 'off' });
  }
  return Promise.resolve({ ok: false });
}

function cleanString(v) {
  if (v == null) return '';
  return String(v).trim();
}

// ─── Funnel thank-you redirect ─────────────────────────────────────────────
// When these GHL thank-you page URLs are set, a finished lead is redirected to
// the designed thank-you page (FILE 2 / FILE 3) instead of the in-form screen.
// Booked leads get ?start=<ISO>&tz=<zone>&fmt=... so the page can show the time.
// Leave a URL empty to keep using the built-in thank-you slide for that path.
const FUNNEL_THANKYOU = {
  booked: 'https://realestate.jacobslifeinvegas.com/thankyou/jacob', // booked-a-call page (FILE 2); gets ?start&tz&fmt
  team: 'https://realestate.jacobslifeinvegas.com/thankyou/team',    // team-routed page (FILE 3)
};

function maybeRedirectThankYou() {
  const booked = Boolean(state.data.bookedSlot);
  const base = booked ? FUNNEL_THANKYOU.booked : FUNNEL_THANKYOU.team;
  if (!base) return false; // not configured → use the in-form thank-you slide

  let url = base;
  if (booked) {
    const slot = state.data.bookedSlot || {};
    const qs = new URLSearchParams();
    if (slot.startTimeUtc || slot.startTime) qs.set('start', slot.startTimeUtc || slot.startTime);
    if (slot.timezone) qs.set('tz', slot.timezone);
    qs.set('fmt', 'Zoom video');
    const q = qs.toString();
    if (q) url += (base.includes('?') ? '&' : '?') + q;
  }
  try { (window.top || window).location.href = url; }
  catch (e) { window.location.href = url; }
  return true;
}

// ─── Navigation ───
function navigateTo(slideId) {
  const slideDef = SLIDES[slideId];
  if (!slideDef) return;

  if (slideId === 'thank-you' && maybeRedirectThankYou()) return;

  if (state.currentSlide !== slideId) clearSubmissionError();

  const viewport = $('slides-viewport');
  const oldSlide = viewport.querySelector('.slide.active');
  if (oldSlide) {
    oldSlide.classList.remove('active');
    oldSlide.classList.add('exit-left');
    setTimeout(() => oldSlide.remove(), 350);
  }

  if (slideId === 'calendar') {
    const routeCalendarId = state.fullSubmitResult?.route?.calendarId || '';
    if (calendar) calendar.setCalendarId(routeCalendarId);
    enterCalendarFullscreen();
    bootstrapCalendarIfNeeded();
    unlockCalendar();
    if (calendar && state.calendarBootstrapped)
      calendar.refreshAvailability({ preserveDate: false, clearSelectedSlot: true });
  } else {
    exitCalendarFullscreen();
    if (state.flow === 'rent-long' || slideId === 'thank-you') {
      dismissCalendar();
    } else if (state.calendarState === 'dismissed') {
      restoreCalendar();
    } else if (state.calendarState === 'unlocked') {
      relockCalendar();
    }
  }

  const slideEl = renderSlide(slideDef);
  viewport.appendChild(slideEl);
  requestAnimationFrame(() => slideEl.classList.add('active'));

  state.currentSlide = slideId;
  if (state.history[state.history.length - 1] !== slideId) {
    state.history.push(slideId);
    if (state.history.length > 20) state.history = state.history.slice(-20);
  }

  updateStepIndicator(slideId);
}

function updateStepIndicator(slideId) {
  const formStep = $('step-form');
  const bookStep = $('step-calendar');
  const route = state.fullSubmitResult?.route;
  const noCalendar = state.flow === 'rent-long' || route?.type === 'team';

  bookStep.classList.toggle('hidden', noCalendar);

  if (!noCalendar) {
    const isBooking = slideId === 'calendar' || slideId === 'thank-you';
    if (isBooking) {
      formStep.classList.remove('active'); formStep.classList.add('completed');
      bookStep.classList.add('active');
    } else {
      formStep.classList.add('active'); formStep.classList.remove('completed');
      bookStep.classList.remove('active');
    }
  } else {
    formStep.classList.add('active'); formStep.classList.remove('completed');
    bookStep.classList.remove('active');
  }

  $('step-indicator').style.opacity = slideId === 'thank-you' ? '0' : '1';
}

function enterCalendarFullscreen() {
  const container = document.querySelector('.split-container');
  if (container) container.classList.add('calendar-fullscreen');
}

function exitCalendarFullscreen() {
  const container = document.querySelector('.split-container');
  if (container) container.classList.remove('calendar-fullscreen');
}

function setFormFullWidth(on) {
  const fp = document.querySelector('.form-panel');
  if (fp) fp.classList.toggle('full-width', !!on);
}

function unlockCalendar() {
  state.calendarState = 'unlocked';
  const panel = $('calendar-panel');
  if (panel) panel.classList.remove('locked');
  const overlay = $('calendar-lock-overlay');
  if (overlay) overlay.classList.add('unlocked');
  setFormFullWidth(false);
  bootstrapCalendarIfNeeded();
}

function relockCalendar() {
  state.calendarState = 'locked';
  const panel = $('calendar-panel');
  if (panel) panel.classList.add('locked');
  const overlay = $('calendar-lock-overlay');
  if (overlay) overlay.classList.remove('unlocked');
  setFormFullWidth(false);
}

function dismissCalendar() {
  state.calendarState = 'dismissed';
  const panel = $('calendar-panel');
  if (panel) panel.classList.add('dismissing');
  // Calendar collapsed → let the form panel fill the width (no empty half / divider).
  setFormFullWidth(true);
}

function restoreCalendar() {
  state.calendarState = 'locked';
  const panel = $('calendar-panel');
  panel.classList.remove('dismissing');
  panel.classList.add('locked');
  const overlay = $('calendar-lock-overlay');
  if (overlay) overlay.classList.remove('unlocked');
  setFormFullWidth(false);
}

function bootstrapCalendarIfNeeded() {
  if (state.calendarBootstrapped) return;
  state.calendarBootstrapped = true;
  if (calendar) calendar.render({ skipFetch: true });
}

// ─── Render ───
function renderSlide(def) {
  const el = document.createElement('div');
  el.className = 'slide';
  el.id = `slide-${def.id}`;

  const isTY = def.type === 'thank-you';
  const isCal = def.type === 'calendar';
  if (isTY) el.classList.add('slide-thank-you');

  const canGoBack = state.history.length > 0 && def.id !== 'thank-you';
  el.innerHTML = `
    <div class="slide-content">
      ${canGoBack && !isTY && !isCal ? '<button class="btn-back" onclick="goBack()">\u2190 Back</button>' : ''}
      ${!isTY && !isCal ? `<h2 class="slide-title">${escHtml(def.title)}</h2>` : ''}
      ${!isTY && !isCal && def.subtitle ? `<p class="slide-subtitle">${escHtml(def.subtitle)}</p>` : ''}
      <div class="slide-body"></div>
    </div>
  `;

  const body = el.querySelector('.slide-body');
  if (def.type === 'contact') renderContactForm(body);
  else if (def.type === 'choice') renderChoice(body, def);
  else if (def.type === 'address') renderAddress(body, def);
  else if (def.type === 'comments') renderComments(body);
  else if (def.type === 'calendar') { /* calendar content is in right panel */ }
  else if (def.type === 'thank-you') renderThankYou(body);

  if (state.submissionError) {
    const errEl = document.createElement('div');
    errEl.className = 'submission-error';
    errEl.setAttribute('role', 'alert');
    errEl.textContent = state.submissionError;
    body.prepend(errEl);
  }

  return el;
}

function renderContactForm(container) {
  container.innerHTML = `
    <div class="input-group">
      <div class="input-row">
        <div class="input-field">
          <label for="fname">First Name</label>
          <input type="text" id="fname" name="firstName" autocomplete="given-name" placeholder="Jane" value="${escHtml(state.data.firstName || '')}">
          <div class="input-error" id="fname-error"></div>
        </div>
        <div class="input-field">
          <label for="lname">Last Name</label>
          <input type="text" id="lname" name="lastName" autocomplete="family-name" placeholder="Doe" value="${escHtml(state.data.lastName || '')}">
          <div class="input-error" id="lname-error"></div>
        </div>
      </div>

      <div class="input-field">
        <label for="phone">Phone Number</label>
        <div class="phone-input-wrapper" id="phone-wrapper">
          <button class="country-picker-btn" id="country-btn" type="button">
            <span class="country-flag">${state.selectedCountry.flag}</span>
            <span class="country-code">${state.selectedCountry.dial}</span>
            <span class="picker-arrow">\u25BC</span>
          </button>
          <input type="tel" id="phone" name="phone" autocomplete="tel-national" inputmode="tel" placeholder="${state.selectedCountry.format.replace(/X/g, '5')}" value="${formatPhone(state.phoneDigits)}">
          <div class="country-dropdown">
            ${COUNTRIES.map(c => `
              <div class="country-option" onclick="selectCountry('${c.code}')">
                <span class="country-flag">${c.flag}</span>
                <span class="country-option-name">${c.name}</span>
                <span class="country-option-code">${c.dial}</span>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="input-error" id="phone-error"></div>
      </div>

      <div class="input-field">
        <label for="email">Email Address</label>
        <input type="email" id="email" name="email" autocomplete="email" autocapitalize="off" spellcheck="false" placeholder="jane@example.com" value="${escHtml(state.data.email || '')}">
        <div class="input-error" id="email-error"></div>
      </div>
    </div>

    <label class="consent-check" for="consent-checkbox">
      <input type="checkbox" id="consent-checkbox" name="consentAccepted" autocomplete="off" required ${state.data.consentAccepted ? 'checked' : ''}>
      <span>By entering your information and checking this box, you agree to receive email, phone, and SMS communications from Jacob Orth.</span>
    </label>
    <div class="input-error" id="consent-error"></div>
    <button class="btn-primary" onclick="validateAndNext('contact')">Continue \u2192</button>
  `;

  setTimeout(() => {
    const phoneInput = container.querySelector('#phone');
    const countryBtn = container.querySelector('#country-btn');
    const dropdown = container.querySelector('.country-dropdown');
    const consent = container.querySelector('#consent-checkbox');

    if (phoneInput) phoneInput.addEventListener('input', handlePhoneInput);
    if (countryBtn) {
      countryBtn.addEventListener('click', e => { e.stopPropagation(); dropdown?.classList.toggle('open'); });
    }
    if (consent) consent.addEventListener('change', () => { if (consent.checked) clearInputError('consent'); });
  }, 0);
}

function renderChoice(container, def) {
  const selected = state.data[def.field];
  container.innerHTML = `
    <div class="choices-grid">
      ${def.options.map(opt => `
        <button class="choice-btn ${selected === opt.value ? 'selected' : ''}" data-choice-value="${escHtml(opt.value)}">
          ${escHtml(opt.label)}
        </button>
      `).join('')}
    </div>
    ${def.submitLabel ? `
      <div class="input-error choice-error" id="choice-error-${def.field}"></div>
      <button class="btn-primary" onclick="validateAndNext('${def.id}')">${def.submitLabel}</button>
    ` : ''}
  `;

  setTimeout(() => {
    container.querySelectorAll('.choice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        window.handleChoice(btn.dataset.choiceValue);
      });
    });
  }, 0);
}

function renderAddress(container, def) {
  container.innerHTML = `
    <div class="address-input-wrapper">
      <span class="address-icon">\u{1F4CD}</span>
      <label class="sr-only" for="addr-input">${def.title}</label>
      <input type="text" id="addr-input" name="propertyAddress" placeholder="${def.placeholder || 'Start typing address...'}" autocomplete="street-address" value="${escHtml(state.data.propertyAddress || '')}">
      <div class="address-results"></div>
    </div>
    <div class="address-status" id="address-status">Type at least 3 characters to search.</div>
    <div class="address-manual-link">Can't find it? Enter manually and continue.</div>
    <div class="input-error" id="address-error"></div>
    <button class="btn-primary" style="margin-top: 12px;" onclick="confirmAddressAndSubmit('${def.id}')">${def.submitLabel || 'Submit'}</button>
  `;

  setTimeout(() => {
    const input = container.querySelector('#addr-input');
    if (!input) return;
    input.focus();
    input.addEventListener('input', e => {
      const val = e.target.value.trim();
      state.data.propertyAddress = val;
      handleAddressSearch(val);
    });
  }, 50);
}

function renderComments(container) {
  container.innerHTML = `
    <div class="input-field">
      <label class="sr-only" for="comments-input">General comments</label>
      <textarea id="comments-input" name="comments" rows="5" maxlength="1000"
        placeholder="Tell the team anything that helps — must-haves, neighborhoods you're eyeing, questions, timing, or anything else you want them to know. (Optional)">${escHtml(state.data.comments || '')}</textarea>
    </div>
    <button class="btn-primary" onclick="submitWithComments()">Submit</button>
  `;
  setTimeout(() => {
    const t = container.querySelector('#comments-input');
    if (t) t.focus();
  }, 50);
}

function renderThankYou(container) {
  const route = state.fullSubmitResult?.route;
  const booked = Boolean(state.data.bookedSlot);

  if (booked || route?.type === 'jacob') {
    container.innerHTML = `
      <div class="thank-you-content">
        <div class="thank-you-icon">\u2705</div>
        <h1>Your Call is Scheduled!</h1>
        <p>Jacob will be in touch at the scheduled time. Check your email for confirmation.</p>
      </div>
    `;
  } else {
    container.innerHTML = `
      <div class="thank-you-content">
        <div class="thank-you-icon">\u2709\uFE0F</div>
        <h1>Thank You!</h1>
        <p>Your information has been received. A member of our team will be in touch shortly.</p>
      </div>
    `;
  }
}

// ─── Logic ───
window.goBack = () => {
  if (state.history.length < 2) return;
  if (state.currentSlide === 'calendar' || state.currentSlide === 'comments' || state.currentSlide === 'preapproval' || state.currentSlide === 'origin' || state.currentSlide === 'buy-timeline' || state.currentSlide === 'address') {
    state.fullSubmitResult = null;
    delete state.data.bookedSlot;
  }
  state.history.pop();
  const prev = state.history.pop();
  if (!prev) return;
  if (prev === 'contact') {
    state.flow = null;
    if (state.calendarState === 'dismissed') restoreCalendar();
    else if (state.calendarState === 'unlocked') relockCalendar();
  }
  navigateTo(prev);
};

window.handleChoice = async value => {
  const slideId = state.currentSlide;
  const def = SLIDES[slideId];
  if (!def) return;

  clearSubmissionError();
  state.data[def.field] = value;
  clearChoiceError(def.field);

  if (slideId === 'intent') setFlow(value);

  if (slideId === 'intent' && value === 'rent-long') {
    // rent-long has no follow-up questions; jump straight to the optional comments step,
    // which performs the final submit.
    navigateTo('comments');
    return;
  }

  if (def.submitLabel) {
    syncSelectedChoice(slideId, value);
    return;
  }

  if (def.isTerminal) {
    try {
      await submitForm();
      const nextId = def.next(value);
      if (nextId) navigateTo(nextId); else navigateTo('thank-you');
    } catch (error) {
      setSubmissionError(error?.message || 'We could not submit your form. Please try again.');
    }
    return;
  }

  const nextId = def.next(value);
  if (nextId) navigateTo(nextId); else {
    try {
      await submitForm();
      navigateTo('thank-you');
    } catch (error) {
      setSubmissionError(error?.message || 'We could not submit your form. Please try again.');
    }
  }
};

window.validateAndNext = async slideId => {
  const def = SLIDES[slideId];
  if (!def) return;
  clearSubmissionError();

  if (slideId === 'contact') {
    const valid = validateContactStep();
    if (!valid) return;
    if (!state.partialSent) {
      sendPartialWebhook();
      state.partialSent = true;
    }
    bootstrapCalendarIfNeeded();
    navigateTo('intent');
    return;
  }

  if (def.type === 'choice') {
    const selected = state.data[def.field];
    if (!selected) { setChoiceError(def.field, 'Please choose an option.'); return; }

    if (def.isTerminal) {
      try {
        await submitForm();
        const nextId = def.next(selected);
        if (nextId) navigateTo(nextId); else navigateTo('thank-you');
      } catch (error) {
        setSubmissionError(error?.message || 'We could not submit your form. Please try again.');
      }
      return;
    }
    const nextId = def.next(selected);
    if (nextId) navigateTo(nextId);
  }
};

window.confirmAddressAndSubmit = slideId => {
  const input = document.querySelector('#addr-input');
  const errEl = document.querySelector('#address-error');
  const val = input?.value?.trim();

  if (!val) {
    if (errEl) errEl.textContent = 'Address is required.';
    return;
  }
  if (errEl) errEl.textContent = '';
  state.data.propertyAddress = val;

  const def = SLIDES[slideId];
  navigateTo(def?.next ? def.next() : 'comments');
};

// Final step for every flow: capture the optional general comments, then submit.
window.submitWithComments = async () => {
  const ta = document.querySelector('#comments-input');
  state.data.comments = ta ? ta.value.trim() : '';

  try {
    await submitForm();
    const route = state.fullSubmitResult?.route;
    if (route?.type === 'jacob') navigateTo('calendar');
    else navigateTo('thank-you');
  } catch (error) {
    setSubmissionError(error?.message || 'We could not submit your form. Please try again.');
  }
};

function validateContactStep() {
  const firstName = document.querySelector('#fname')?.value?.trim() || '';
  const lastName = document.querySelector('#lname')?.value?.trim() || '';
  const email = document.querySelector('#email')?.value?.trim() || '';
  const consent = document.querySelector('#consent-checkbox')?.checked;
  let isValid = true;

  clearInputError('fname'); clearInputError('lname'); clearInputError('email'); clearInputError('phone', true); clearInputError('consent');

  if (!firstName) { setInputError('fname', 'First name is required.'); isValid = false; }
  if (!lastName) { setInputError('lname', 'Last name is required.'); isValid = false; }
  if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) {
    setInputError('email', 'Please enter a valid email address.'); isValid = false;
  }

  const phoneErr = validatePhone();
  if (phoneErr) { setInputError('phone', phoneErr, true); isValid = false; }

  if (!consent) { setInputError('consent', 'You must agree to continue.'); isValid = false; }
  if (!isValid) return false;

  state.data.firstName = firstName;
  state.data.lastName = lastName;
  state.data.email = email;
  state.data.phone = state.selectedCountry.dial + state.phoneDigits;
  state.data.consentAccepted = consent;
  return true;
}

function validatePhone() {
  if (!state.phoneDigits) return 'Phone number is required.';
  const c = state.selectedCountry;
  if (c.code === 'US' || c.code === 'CA') {
    const raw = state.phoneRawDigits || state.phoneDigits;
    if (raw.length < 10) return 'Phone number is too short.';
    if (raw.length > 11) return 'Phone number is too long.';
    const normalized = raw.length === 11 && raw.startsWith('1') ? raw.slice(1) : raw;
    if (normalized.length !== 10) return 'US/Canada numbers must be 10 digits.';
    const parsed = parsePhoneNumberFromString(normalized, c.code);
    if (!parsed || !parsed.isValid()) return 'Please enter a valid US/Canada number.';
    return '';
  }
  if (state.phoneDigits.length < c.maxDigits) return 'Phone number is too short.';
  return '';
}

function setFlow(intentValue) {
  if (intentValue === 'buy') {
    delete state.data.propertyAddress;
    delete state.data.buyTimeline; // only asked of short-term renters
  } else if (intentValue === 'rent-short') {
    delete state.data.propertyAddress;
  } else if (intentValue === 'sell') {
    delete state.data.priceRange;
    delete state.data.preApproval;
    delete state.data.movingFrom;
    delete state.data.buyTimeline;
  } else if (intentValue === 'rent-long') {
    delete state.data.propertyAddress;
    delete state.data.timeline;
    delete state.data.priceRange;
    delete state.data.preApproval;
    delete state.data.movingFrom;
    delete state.data.buyTimeline;
  }

  state.flow = intentValue === 'buy' ? 'buyer'
    : intentValue === 'sell' ? 'seller'
    : intentValue === 'rent-short' ? 'rent-short'
    : 'rent-long';

  if (intentValue === 'rent-long') dismissCalendar();
  else if (state.calendarState === 'dismissed') restoreCalendar();
}

async function sendPartialWebhook() {
  try {
    const result = await postToBackend('/api/submit/partial', {
      firstName: state.data.firstName,
      lastName: state.data.lastName,
      email: state.data.email,
      phone: state.data.phone,
    });
    if (result.ok) {
      state.data.contactId = result.contactId;
      state.data.opportunityId = result.opportunityId;
    }
  } catch (e) {
    console.warn('Partial submit failed (non-blocking):', e.message);
  }
}

async function submitForm() {
  if (state.submissionInFlight) return;
  state.submissionInFlight = true;

  try {
    const result = await postToBackend('/api/submit/full', {
      firstName: state.data.firstName,
      lastName: state.data.lastName,
      email: state.data.email,
      phone: state.data.phone,
      intent: state.flow === 'buyer' ? 'buy'
        : state.flow === 'seller' ? 'sell'
        : state.flow === 'rent-short' ? 'rent-short'
        : 'rent-long',
      timeline: state.data.timeline || null,
      priceRange: state.data.priceRange || null,
      preApproval: state.data.preApproval || null,
      movingFrom: state.data.movingFrom || null,
      buyTimeline: state.data.buyTimeline || null,
      propertyAddress: state.data.propertyAddress || null,
      comments: state.data.comments || null,
      contactId: state.data.contactId || '',
      opportunityId: state.data.opportunityId || '',
    });

    if (!result.ok) throw new Error(result.error || 'Submission failed.');

    state.fullSubmitResult = result;
    if (result.contactId) state.data.contactId = result.contactId;
    if (result.opportunityId) state.data.opportunityId = result.opportunityId;
  } catch (error) {
    throw error;
  } finally {
    state.submissionInFlight = false;
  }
}

function syncSelectedChoice(slideId, value) {
  const slide = document.querySelector(`#slide-${slideId}`);
  if (!slide) return;
  slide.querySelectorAll('.choice-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.choiceValue === value);
  });
}

// ─── Phone ───
window.handlePhoneInput = e => {
  const raw = e.target.value.replace(/\D/g, '');
  state.phoneRawDigits = raw;
  let digits = raw;
  if ((state.selectedCountry.code === 'US' || state.selectedCountry.code === 'CA') && digits.length === 11 && digits.startsWith('1'))
    digits = digits.slice(1);
  if (digits.length > state.selectedCountry.maxDigits) digits = digits.slice(0, state.selectedCountry.maxDigits);
  state.phoneDigits = digits;
  e.target.value = formatPhone(digits);
};

function formatPhone(digits) {
  if (!digits) return '';
  const fmt = state.selectedCountry.format;
  let idx = 0;
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === 'X') {
      if (idx < digits.length) out += digits[idx++];
      else break;
    } else if (idx < digits.length) {
      out += ch;                 // separator with more digits still to place
    } else if (ch === ')') {
      out += ch;                 // keep a closing paren right after the last digit
    } else {
      break;                     // drop trailing separators (space/dash) so backspace works
    }
  }
  return out;
}

window.selectCountry = code => {
  const c = COUNTRIES.find(x => x.code === code);
  if (!c) return;
  state.selectedCountry = c;
  const btn = document.querySelector('#country-btn');
  if (btn) {
    btn.innerHTML = `<span class="country-flag">${c.flag}</span><span class="country-code">${c.dial}</span><span class="picker-arrow">\u25BC</span>`;
  }
  const input = document.querySelector('#phone');
  if (input) { input.placeholder = c.format.replace(/X/g, '5'); input.value = ''; }
  state.phoneDigits = '';
  state.phoneRawDigits = '';
  clearInputError('phone', true);
  const dd = document.querySelector('.country-dropdown');
  if (dd) dd.classList.remove('open');
};

// ─── Address ───
window.handleAddressSearch = query => {
  clearTimeout(addressSearchTimer);
  const results = document.querySelector('.address-results');
  const statusEl = document.querySelector('#address-status');
  if (!results) return;

  const t = query.trim();
  if (t.length < 3) {
    results.innerHTML = ''; results.classList.remove('open');
    if (statusEl) statusEl.textContent = 'Type at least 3 characters to search.';
    return;
  }

  if (statusEl) statusEl.textContent = 'Searching addresses...';

  addressSearchTimer = setTimeout(async () => {
    const reqId = ++addressLookupRequestId;
    try {
      const resp = await fetchFromBackend(`/api/address/autocomplete?text=${encodeURIComponent(t)}&limit=5&country=us`);
      if (reqId !== addressLookupRequestId) return;
      const features = Array.isArray(resp?.features) ? resp.features : [];
      if (!features.length) {
        results.innerHTML = ''; results.classList.remove('open');
        if (statusEl) statusEl.textContent = 'No matches found. Enter manually.';
        return;
      }
      renderAddressResults(features);
      if (statusEl) statusEl.textContent = '';
    } catch {
      if (reqId !== addressLookupRequestId) return;
      results.innerHTML = ''; results.classList.remove('open');
      if (statusEl) statusEl.textContent = 'Address lookup unavailable. Enter manually.';
    }
  }, 250);
};

function renderAddressResults(features) {
  const results = document.querySelector('.address-results');
  if (!results) return;
  results.innerHTML = '';
  features.forEach(f => {
    const line1 = f?.properties?.address_line1 || f?.properties?.formatted || '';
    const line2 = f?.properties?.address_line2 || '';
    const formatted = f?.properties?.formatted || line1;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'address-result-item';
    const main = document.createElement('div'); main.className = 'address-result-main'; main.textContent = line1;
    const sub = document.createElement('div'); sub.className = 'address-result-sub'; sub.textContent = line2;
    btn.append(main, sub);
    btn.addEventListener('click', () => selectAddress(formatted));
    results.appendChild(btn);
  });
  results.classList.add('open');
}

function selectAddress(address) {
  if (!address) return;
  state.data.propertyAddress = address;
  const input = document.querySelector('#addr-input');
  if (input) input.value = address;
  const results = document.querySelector('.address-results');
  if (results) { results.innerHTML = ''; results.classList.remove('open'); }
  const statusEl = document.querySelector('#address-status');
  if (statusEl) statusEl.textContent = 'Selected. Confirm to continue.';
  const errEl = document.querySelector('#address-error');
  if (errEl) errEl.textContent = '';
}

// ─── Error Helpers ───
function setChoiceError(field, msg) {
  const el = document.querySelector(`#choice-error-${field}`);
  if (el) el.textContent = msg;
}

function clearChoiceError(field) { setChoiceError(field, ''); }

function setInputError(id, msg, isPhone) {
  const err = document.querySelector(`#${id}-error`);
  const inp = document.querySelector(`#${id}`);
  if (err) err.textContent = msg;
  if (inp) inp.classList.add('error');
  if (isPhone) { const w = document.querySelector('#phone-wrapper'); if (w) w.classList.add('error'); }
  if (id === 'consent') { const c = document.querySelector('.consent-check'); if (c) c.classList.add('error'); }
}

function clearInputError(id, isPhone) {
  const err = document.querySelector(`#${id}-error`);
  const inp = document.querySelector(`#${id}`);
  if (err) err.textContent = '';
  if (inp) inp.classList.remove('error');
  if (isPhone) { const w = document.querySelector('#phone-wrapper'); if (w) w.classList.remove('error'); }
  if (id === 'consent') { const c = document.querySelector('.consent-check'); if (c) c.classList.remove('error'); }
}

function setSubmissionError(msg) {
  state.submissionError = msg || 'We could not submit your form. Please try again.';
  const activeBody = document.querySelector('.slide.active .slide-body');
  if (!activeBody) return;
  let errEl = activeBody.querySelector('.submission-error');
  if (!errEl) {
    errEl = document.createElement('div');
    errEl.className = 'submission-error';
    errEl.setAttribute('role', 'alert');
    activeBody.prepend(errEl);
  }
  errEl.textContent = state.submissionError;
}

function clearSubmissionError() {
  state.submissionError = '';
  document.querySelectorAll('.submission-error').forEach(e => e.remove());
}

function populateCalendarGraphic() {
  const grid = document.getElementById('cg-grid');
  const monthLabel = document.querySelector('.cg-month');
  if (!grid || !monthLabel) return;

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const monthName = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  monthLabel.textContent = monthName;

  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  grid.innerHTML = '';
  for (let i = 0; i < firstDow; i++) {
    const empty = document.createElement('div');
    empty.className = 'cg-cell cg-empty';
    grid.appendChild(empty);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const cell = document.createElement('div');
    cell.className = 'cg-cell';
    if (d === now.getDate()) cell.classList.add('cg-today');
    cell.textContent = String(d);
    grid.appendChild(cell);
  }
}

// ─── Auto-size when embedded: report this widget's real height to the parent ───
// so the iframe can be sized to the content exactly (no dead space, no inner scroll).
(function setupEmbedAutoHeight() {
  if (window.parent === window) return; // only when embedded in an iframe
  const app = document.getElementById('form-app');
  if (!app) return;
  let last = 0, queued = false;
  const post = () => {
    queued = false;
    const cs = getComputedStyle(app);
    const h = Math.ceil(app.getBoundingClientRect().height
      + parseFloat(cs.marginTop || 0) + parseFloat(cs.marginBottom || 0));
    if (!h || h === last) return;
    last = h;
    window.parent.postMessage({ type: 'jo-form:height', px: h }, '*');
  };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(post); } };
  if ('ResizeObserver' in window) new ResizeObserver(schedule).observe(app);
  window.addEventListener('load', schedule);
  window.addEventListener('resize', schedule);
  [100, 400, 900, 1600].forEach(t => setTimeout(schedule, t)); // catch late layout/fonts
})();
