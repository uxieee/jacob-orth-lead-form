import { normalizeConfig, validateConfig, evaluateRoute, DEFAULT_ROUTING_CONFIG } from '../shared/routing-config.js';

/* ============================================================
   Jacob Orth — Lead Form Cloudflare Worker Backend Gateway
   ------------------------------------------------------------
   Endpoints:
   - GET  /api/health
   - GET  /api/free-slots
   - GET  /api/address/autocomplete
   - POST /api/submit/partial
   - POST /api/submit/full
   - POST /api/appointments/book
   - GET  /api/switch
   - POST /api/switch
   ============================================================ */

const GEO_BASE_URL = 'https://api.geoapify.com/v1/geocode';
const GHL_BASE_URL = 'https://services.leadconnectorhq.com';
const GHL_PUBLIC_BASE_URL = 'https://backend.leadconnectorhq.com';

const FORM_SOURCE = 'jacob-lead-form';

// ─── GHL IDs (hardcoded per BUILD_SPEC §3) ───
// Pipeline: "Leads" (W4fFWnbaey00Y01G2Mbg) — the dedicated lead-routing pipeline.
const LOCATION_ID   = 'nkdEvYCLAfHu5d0jtCUi';
const PIPELINE_ID   = 'W4fFWnbaey00Y01G2Mbg';
const STAGE_NEW     = '2169701e-c09c-4e43-9566-d61b90fc37cf'; // New Lead (Jacob leads land here)
const STAGE_BOOKED  = '87db2e9e-5897-41e0-b0fd-cbf4eb41210e'; // Call Booked (advance on booking)
const STAGE_TEAM    = 'e55e3a80-7c94-431d-b357-2beaee2ebd53'; // Not Ready Yet (team leads created here).
                                                              // Renamed from "Routed to AttractZen" 2026-08-20; ID deliberately preserved.
const JACOB_USER_ID = 'CiTBDGMnJYAHmCQHTnG4';
const JACOB_CAL_ID  = 'ihPuGwHD3lLJkey3WCEE';

const FIELD = {
  leadIntent:  'N1Hwt3BITgBTVfO7aUWa',
  timeline:    'moPLFSSpXwAAwAtdThos',
  priceRange:  'LIZiAYE7aEjgNeUb14lQ',
  preApproval: 'oHQwLfLsdiliSm8qLx5W',
  routedTo:    'bLSNGJe2ntvkzToHVI4O',
  // Added 2026-08-12. movingFrom separates relocating buyers (nurture lane A) from local
  // ones (lane B) and supplies the origin state the money-math messaging is built on.
  // buyTimeline exists because "when would you like to move?" measures the wrong event
  // for short-term renters — moving means entering a rental; buying is a later event.
  movingFrom:  'qaQOXMKWE1cTj3SunKW8',
  buyTimeline: 'ZM966WyYREEP5ok81ZlF',
  // Added 2026-08-20. Both were note-text-only until the fields existed in this location.
  // A note cannot be filtered, searched, merged into a message, or used as a condition.
  propertyAddress: 'U8Va2mYkWoWFy5yN1B1T',
  leadComments:    '01Wr8IK2QhWAHLV9UHnH',
};

const CV_OVERFLOW_MODE_ID = 'UMbWGtqqJhR7hTYj0JMR';
const CV_TEAM_URL_ID      = '2XJSSBh5oJ1vSkstlblP';
const CV_ROUTING_CONFIG_ID = 'oCW19w9RTcReglS7mYXm';

const CV_NAMES = {
  [CV_OVERFLOW_MODE_ID]: 'overflow_mode',
  [CV_TEAM_URL_ID]: 'team_handoff_url',
  [CV_ROUTING_CONFIG_ID]: 'routing_config',
};

// ─── Tags ───
// Tag cull, 2026-08-20 (Nothing Slips rev 3): 12 tags down to 8.
// Rule — if a field or a pipeline stage already says it, the tag goes. Retired here:
//   jo-submitted      → said by the opportunity existing at all
//   jo-booked         → said by the appointment existing, plus the Call Booked stage
//   needs-preapproval → said by opportunity.preapproval_status = "No - please connect me"
//   rt-team           → said by the Not Ready Yet stage, plus opportunity.routed_to = "Team"
// rt-jacob SURVIVES for a mechanical reason: the opportunity_created trigger can filter on
// pipeline, tag, assigned user, monetary value, close date, probability, status and lost
// reason — NOT on stage and NOT on a custom field. It is the only usable entry gate for 001.
const TAG_PARTIAL       = 'jo-partial';
const TAG_BOOKING_FAIL  = 'jo-booking-failed';
const TAG_JACOB         = 'rt-jacob';
const TAG_OVERFLOW      = 'rt-overflow';

const INTENT_TAGS = {
  'buy':        'lead type - buyer',
  'sell':       'lead type - seller',
  'rent-short': 'lead type - renting short term',
  'rent-long':  'lead type - renter',
};

// Option labels (exact strings for custom field values)
const LABELS = {
  intent: {
    'buy':        'Buy a home',
    'sell':       'Sell a home',
    'rent-short': 'Rent short-term (then buy soon)',
    'rent-long':  'Rent long-term (no plans to buy)',
  },
  timeline: {
    'asap':  'As soon as possible',
    '<3mo':  'Sooner than 3 months',
    '3-6mo': '3 to 6 months',
    '6-12mo':'6 to 12 months',
    '1y+':   '1+ year',
  },
  priceRange: {
    '<250k':    'Under $250k',
    '250k-500k':'$250k - $500k',
    '500k-1m':  '$500k - $1M',
    '1m-2m':    '$1M - $2M',
    '>2m':      '$2M+',
  },
  preApproval: {
    'no-connect': 'No - please connect me',
    'yes':        'Yes - pre-approval in hand',
    'cash':       'Buying with cash',
  },
};

// Booking idempotency dedup map (in-memory, per-isolate)
const BOOKING_DEDUP = new Map();
const BOOKING_DEDUP_TTL_MS = 30000;
const BOOKING_DEDUP_MAX_SIZE = 500;

// ─── Helpers ───
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function cleanString(v) {
  if (v == null) return '';
  return String(v).trim();
}

function sanitizeGhlId(v) {
  const c = cleanString(v);
  if (!c) return '';
  if (!/^[a-zA-Z0-9_-]+$/.test(c)) return '';
  return c;
}

function jsonResponse(payload, status, corsHeaders) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function buildCorsHeaders(env, request) {
  const origin = cleanString(request?.headers?.get('Origin'));
  const allowed = cleanString(env.ALLOWED_ORIGINS || '*');
  const origins = allowed === '*' ? ['*'] : allowed.split(/[\n,;]/).map(s => s.trim()).filter(Boolean);

  let allowOrigin = origins.includes('*') ? '*' : '';
  if (!allowOrigin && origins.length > 0) {
    allowOrigin = origin && origins.includes(origin) ? origin : origins[0];
  }

  const headers = {
    'Access-Control-Allow-Origin': allowOrigin || '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-switch-secret',
    'Access-Control-Max-Age': '86400',
  };
  if (allowOrigin && allowOrigin !== '*') headers['Vary'] = 'Origin';
  return headers;
}

function toLabel(group, value) {
  const raw = cleanString(value);
  if (!raw) return '';
  return LABELS[group]?.[raw] || raw;
}

function pushCustomField(arr, fieldId, value) {
  const v = cleanString(value);
  if (!fieldId || !v) return;
  arr.push({ id: fieldId, field_value: v });
}

const MAX_BODY = 102400;

function isBodyTooLarge(request) {
  const len = parseInt(request.headers.get('content-length') || '0', 10);
  return len > MAX_BODY;
}

async function safeReadJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function readResponsePayload(response) {
  try { return await response.json(); } catch {
    try { return { detail: await response.text() }; } catch { return { detail: '' }; }
  }
}

function extractErrorMessage(payload, fallback) {
  if (!payload) return fallback || 'Request failed';
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  if (Array.isArray(payload?.message) && payload.message.length)
    return payload.message.map(m => cleanString(m)).filter(Boolean).join(', ');
  for (const k of ['message','error','detail','details']) {
    const v = cleanString(payload[k]);
    if (v) return v;
  }
  try { return JSON.stringify(payload); } catch { return fallback || 'Request failed'; }
}

function buildGhlHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: '2021-07-28',
  };
}

async function ghlRequest(env, method, path, { query, body } = {}) {
  const apiKey = cleanString(env.GHL_API_TOKEN);
  if (!apiKey) return { ok: false, status: 500, payload: { error: 'GHL_API_TOKEN not configured' } };

  const url = new URL(`${GHL_BASE_URL}${path}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v == null) continue;
      const n = cleanString(v);
      if (!n) continue;
      url.searchParams.set(k, n);
    }
  }

  const headers = buildGhlHeaders(apiKey);
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const resp = await fetch(url.toString(), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const payload = await readResponsePayload(resp);
  return { ok: resp.ok, status: resp.status, payload };
}

// ─── Custom Values ───
async function readCustomValue(env, cvId) {
  const result = await ghlRequest(env, 'GET', `/locations/${LOCATION_ID}/customValues/${cvId}`);
  if (!result.ok) return '';
  return cleanString(result.payload?.customValue?.value);
}

async function writeCustomValue(env, cvId, value) {
  return await ghlRequest(env, 'PUT', `/locations/${LOCATION_ID}/customValues/${cvId}`, {
    body: { name: CV_NAMES[cvId] || '', value },
  });
}

// ─── resolveLeadRoute (BUILD_SPEC §6) ───
async function resolveLeadRoute(env, payload) {
  const overflow = await readCustomValue(env, CV_OVERFLOW_MODE_ID);
  // Overflow always wins (unchanged). A lead that already booked with Jacob is never re-routed —
  // booking is a separate later action that never consults overflow.
  if (overflow === 'on') return { type: 'team', reason: 'overflow switch on', overflow: true };

  const config = await readRoutingConfig(env);
  return { ...evaluateRoute(config, payload), overflow: false };
}

// Read the routing-config custom value (JSON string) and normalize. Any failure → defaults.
async function readRoutingConfig(env) {
  try {
    const raw = await readCustomValue(env, CV_ROUTING_CONFIG_ID); // '' on miss → normalizeConfig → defaults
    return normalizeConfig(raw);
  } catch {
    return normalizeConfig(DEFAULT_ROUTING_CONFIG);
  }
}

// ─── Contact & Opportunity ───
async function upsertContact(env, payload) {
  const fn = cleanString(payload.firstName);
  const ln = cleanString(payload.lastName);
  return await ghlRequest(env, 'POST', '/contacts/upsert', {
    body: {
      locationId: LOCATION_ID,
      firstName: fn,
      lastName: ln,
      name: [fn, ln].filter(Boolean).join(' ').trim(),
      email: cleanString(payload.email),
      phone: cleanString(payload.phone),
      source: FORM_SOURCE,
    },
  });
}

async function addTag(env, contactId, tag) {
  return await ghlRequest(env, 'POST', `/contacts/${contactId}/tags`, { body: { tags: [tag] } });
}

async function removeTag(env, contactId, tag) {
  return await ghlRequest(env, 'DELETE', `/contacts/${contactId}/tags`, { body: { tags: [tag] } });
}

// A settled batch never throws, so a failure in one is only visible if we look. A gate tag that
// silently 4xx's is the difference between a lead entering 001 and vanishing, so log every one.
function reportSettled(label, results) {
  results.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`${label} ${i} failed:`, r.reason);
    else if (r.status === 'fulfilled' && r.value && !r.value.ok)
      console.error(`${label} ${i} HTTP error:`, JSON.stringify(r.value.payload));
  });
}

async function addNote(env, contactId, bodyText) {
  const text = cleanString(bodyText);
  if (!text) return { ok: true, status: 200, payload: { skipped: true } };
  return await ghlRequest(env, 'POST', `/contacts/${contactId}/notes`, {
    body: { body: text },
  });
}

async function findOpenOpportunity(env, contactId) {
  const result = await ghlRequest(env, 'GET', '/opportunities/search', {
    query: {
      location_id: LOCATION_ID,
      contact_id: contactId,
      pipeline_id: PIPELINE_ID,
      status: 'open',
      limit: 20,
    },
  });
  if (!result.ok) return null;
  const opps = (Array.isArray(result.payload?.opportunities) ? result.payload.opportunities : [])
    .sort((a, b) => (Date.parse(b?.updatedAt || b?.createdAt || 0) || 0) - (Date.parse(a?.updatedAt || a?.createdAt || 0) || 0));
  return opps[0] || null;
}

function buildOppName(payload) {
  const fn = cleanString(payload.firstName);
  const ln = cleanString(payload.lastName);
  const full = [fn, ln].filter(Boolean).join(' ').trim() || 'Lead';
  const labels = {
    'buy': 'Buying',
    'sell': 'Selling',
    'rent-short': 'Short-term rental',
    'rent-long': 'Long-term rental',
  };
  const label = labels[cleanString(payload.intent)];
  return label ? `${full} — ${label}` : full;
}

export function buildOpportunityCustomFields(payload, routedTo) {
  const customFields = [];
  const intent = cleanString(payload.intent);

  pushCustomField(customFields, FIELD.leadIntent, toLabel('intent', intent));

  if (intent === 'buy' || intent === 'rent-short') {
    pushCustomField(customFields, FIELD.timeline, cleanString(payload.timeline));
    pushCustomField(customFields, FIELD.priceRange, cleanString(payload.priceRange));
    pushCustomField(customFields, FIELD.preApproval, cleanString(payload.preApproval));
    pushCustomField(customFields, FIELD.movingFrom, cleanString(payload.movingFrom));
    // Short-term renters only: their move date is a rental date, not a purchase date.
    if (intent === 'rent-short') {
      pushCustomField(customFields, FIELD.buyTimeline, cleanString(payload.buyTimeline));
    }
  }

  if (intent === 'sell') {
    pushCustomField(customFields, FIELD.timeline, cleanString(payload.timeline));
    pushCustomField(customFields, FIELD.propertyAddress, cleanString(payload.propertyAddress));
  }

  // Every intent. For rent-long it is the only thing the form ever collects about them.
  pushCustomField(customFields, FIELD.leadComments, cleanString(payload.comments));

  pushCustomField(customFields, FIELD.routedTo, routedTo);

  return customFields;
}

async function upsertOpportunity(env, { payload, contactId, opportunityId, assignedTo, stageId = STAGE_NEW }) {
  const routedTo = assignedTo === JACOB_USER_ID ? 'Jacob' : 'Team';
  const customFields = buildOpportunityCustomFields(payload, routedTo);

  let targetOppId = sanitizeGhlId(opportunityId);

  // ONE OPPORTUNITY PER ENQUIRY, not per contact. A person can buy this year and sell the next,
  // or enquire about a rental and later about a purchase — those are separate deals and each
  // deserves its own card, its own stage and its own run through 001. So a full submit CREATES.
  //
  // A threaded opportunityId means "the same form session" and updates that record instead;
  // nothing else short-circuits the create.
  //
  // The POST below can still be refused with 400 OPPORTUNITY_NO_DUPLICATE, because that is an
  // ACCOUNT SETTING rather than a platform rule — GHL is happy with many opportunities per
  // contact, but `settings.allowDuplicateOpportunity` gates it per sub-account. Measured live
  // 2026-09-01 on contact SuKD9Qw9vw5VNH3NyW42, which already had an open opportunity in
  // PIPELINE_ID, while the setting was still false:
  //   POST /opportunities/  pipeline QPORQEzhyyBpO4bbP3XS (a DIFFERENT pipeline) -> 201 Created
  //   POST /opportunities/  pipeline W4fFWnbaey00Y01G2Mbg (the SAME pipeline)    -> 400 duplicate
  // So the refusal is scoped to one OPEN opportunity per contact per pipeline, and it only
  // happens while the setting is off.
  //
  // That refusal is what 502'd every re-submission from the moment the 2026-08-27 fix moved
  // creation here to the full submit. Live failure 2026-08-31T19:22Z: the client's own tester
  // (juan@jacobslifeinvegas.com, whose contact had carried an open opportunity since the
  // 2026-06-19 test) re-submitted, got the 502, and no note, no opportunity event and no
  // workflow followed. The setting is now on, but the recovery below stays: if anyone ever
  // flips it back, a lead's submission must still land rather than 502.
  if (targetOppId) {
    const body = {
      name: buildOppName(payload),
      pipelineId: PIPELINE_ID,
      pipelineStageId: stageId,
      status: 'open',
      customFields,
    };
    if (assignedTo) body.assignedTo = assignedTo;

    const r = await ghlRequest(env, 'PUT', `/opportunities/${targetOppId}`, { body });
    if (r.ok) return { ok: true, payload: { opportunity: { id: targetOppId } } };
    if (r.status === 404) targetOppId = '';
    else return r;
  }

  const body = {
    locationId: LOCATION_ID,
    contactId,
    name: buildOppName(payload),
    pipelineId: PIPELINE_ID,
    pipelineStageId: stageId,
    status: 'open',
    source: FORM_SOURCE,
    customFields,
  };
  if (assignedTo) body.assignedTo = assignedTo;

  const r = await ghlRequest(env, 'POST', '/opportunities/', { body });
  if (!r.ok) {
    // Duplicates are refused only while allowDuplicateOpportunity is off. GHL's rejection names
    // the record it collided with, so fall back to updating that one — a degraded outcome (the
    // two enquiries share a card) but a landed submission rather than a 502 and a lost lead.
    // NO pipelineStageId here on purpose: the record we are folding into may be deep in Jacob's
    // pipeline (Call Booked, Showed), and resetting it to New Lead would erase where he has them.
    const existingId = sanitizeGhlId(r.payload?.meta?.existingId);
    if (r.status === 400 && existingId) {
      const retryBody = { name: buildOppName(payload), pipelineId: PIPELINE_ID, status: 'open', customFields };
      if (assignedTo) retryBody.assignedTo = assignedTo;
      const retry = await ghlRequest(env, 'PUT', `/opportunities/${existingId}`, { body: retryBody });
      if (retry.ok) return { ok: true, payload: { opportunity: { id: existingId } } };
      return retry;
    }
    return r;
  }
  return { ok: true, payload: { opportunity: { id: cleanString(r.payload?.opportunity?.id) } } };
}

// ─── Note builders ───
function buildSubmitNote(payload, route) {
  const lines = [];
  lines.push('Jacob Orth form — full submission');
  lines.push(`Intent: ${toLabel('intent', payload.intent) || cleanString(payload.intent)}`);
  lines.push(`Timeline: ${cleanString(payload.timeline) || '-'}`);
  if (payload.intent === 'buy' || payload.intent === 'rent-short') {
    lines.push(`Price range: ${cleanString(payload.priceRange) || '-'}`);
    lines.push(`Pre-approval: ${cleanString(payload.preApproval) || '-'}`);
    lines.push(`Moving from: ${cleanString(payload.movingFrom) || '-'}`);
    if (payload.intent === 'rent-short')
      lines.push(`Buy timeline: ${cleanString(payload.buyTimeline) || '-'}`);
  }
  if (payload.intent === 'sell' && isNonEmptyString(payload.propertyAddress))
    lines.push(`Property address: ${cleanString(payload.propertyAddress)}`);
  lines.push(`Route: ${route.type} (${route.reason})`);
  if (isNonEmptyString(payload.comments)) {
    lines.push('');
    lines.push('Comments from lead:');
    lines.push(cleanString(payload.comments));
  }
  return lines.join('\n');
}

function buildBookingNote(payload) {
  const lines = [];
  lines.push('Jacob Orth form — booking confirmed');
  const slot = payload?.bookedSlot || payload?.slot || {};
  const start = cleanString(slot.startTime || slot.startTimeUtc || '');
  lines.push(`Booked: ${start || 'unknown'} (${cleanString(slot.timezone || payload?.timezone || '')})`);
  return lines.join('\n');
}

function buildBookingFailureNote(payload, error) {
  const lines = [];
  lines.push('Jacob Orth form — booking failed');
  lines.push(`Error: ${cleanString(error) || 'Unknown'}`);
  return lines.join('\n');
}

// ─── Validation ───
function validateContactPayload(p) {
  if (!p || typeof p !== 'object') return 'Invalid request body';
  if (!isNonEmptyString(p.firstName)) return 'First name is required';
  if (!isNonEmptyString(p.lastName)) return 'Last name is required';
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(cleanString(p.email))) return 'Valid email is required';
  if (!isNonEmptyString(p.phone)) return 'Phone is required';
  return '';
}

function validateFullPayload(p) {
  const e = validateContactPayload(p);
  if (e) return e;
  if (!isNonEmptyString(p.intent)) return 'Intent is required';
  return '';
}

function validateBookingPayload(p) {
  const e = validateContactPayload(p);
  if (e) return e;
  const slot = p?.bookedSlot || p?.slot || {};
  if (!isNonEmptyString(slot.startTime || slot.startTimeUtc || p?.startTimeUtc))
    return 'Slot start time is required';
  return '';
}

function getBookingStartTime(p) {
  const slot = p?.bookedSlot || p?.slot || {};
  return cleanString(slot.startTimeUtc || slot.startTime || p?.startTimeUtc || p?.startTime);
}

// ─── Handlers ───
async function handlePartialSubmit(request, env, corsHeaders) {
  if (isBodyTooLarge(request)) return jsonResponse({ error: 'Body too large' }, 413, corsHeaders);
  const p = await safeReadJson(request);
  const err = validateContactPayload(p);
  if (err) return jsonResponse({ ok: false, error: err }, 400, corsHeaders);

  const contactR = await upsertContact(env, p);
  if (!contactR.ok) {
    console.error('Partial upsert failed:', JSON.stringify(contactR.payload));
    return jsonResponse({ ok: false, error: 'Failed to create contact' }, 502, corsHeaders);
  }

  const contactId = sanitizeGhlId(contactR.payload?.contact?.id);
  if (!contactId) return jsonResponse({ ok: false, error: 'No contact id returned' }, 502, corsHeaders);

  // NO opportunity here — deliberately. Creating one is what fires workflow 001's
  // `opportunity_created` trigger, and at this point the lead has given us a name, an email and a
  // phone number and nothing else: intent, timeline and budget are all still unanswered, so
  // resolveLeadRoute cannot run and `rt-jacob` cannot be known, let alone written. An opportunity
  // created here therefore fires 001's gate against a contact carrying only `jo-partial`, the
  // filter rejects it, and because the full submit then PUTs that same record no second
  // `opportunity_created` ever fires. The lead is silently unreachable for the rest of the funnel.
  //
  // That is exactly what happened to the first real lead through the live system
  // (C9Al6rLNTmwUTg3jwzRc, 2026-08-27): opportunity created here as "Juan Ortiz" at 17:35:08,
  // trigger rejected at 17:35:09 with actual [jo-partial] vs expected rt-jacob, renamed to
  // "Juan Ortiz — Buying" by the full submit at 17:37, and not one of 001's 8 messages sent.
  //
  // It also restores the invariant the 2026-08-20 tag cull was written against — "jo-submitted →
  // said by the opportunity existing at all". That is only true if an opportunity means the form
  // was completed. Drop-offs stay recoverable through the `jo-partial` tag on the contact.
  const tagR = await addTag(env, contactId, TAG_PARTIAL);
  if (!tagR.ok) console.error('Partial tag failed:', JSON.stringify(tagR.payload));

  // opportunityId stays in the response shape so the form's state threading is unchanged; it is
  // empty until the full submit creates the record.
  return jsonResponse({ ok: true, contactId, opportunityId: '' }, 202, corsHeaders);
}

async function handleFullSubmit(request, env, corsHeaders) {
  if (isBodyTooLarge(request)) return jsonResponse({ error: 'Body too large' }, 413, corsHeaders);
  const p = await safeReadJson(request);
  const err = validateFullPayload(p);
  if (err) return jsonResponse({ ok: false, error: err }, 400, corsHeaders);

  const contactR = await upsertContact(env, p);
  if (!contactR.ok) {
    console.error('Full submit contact failed:', JSON.stringify(contactR.payload));
    return jsonResponse({ ok: false, error: 'Failed to upsert contact' }, 502, corsHeaders);
  }

  const contactId = sanitizeGhlId(contactR.payload?.contact?.id);
  if (!contactId) return jsonResponse({ ok: false, error: 'No contact id returned' }, 502, corsHeaders);

  const route = await resolveLeadRoute(env, p);

  const assignedTo = route.type === 'jacob' ? JACOB_USER_ID : null;

  // ─── Tags FIRST, awaited, then the opportunity ───
  // Creating the opportunity is what fires workflow 001, and GHL evaluates 001's tag filter
  // within a second of that POST. Every tag the trigger reads must therefore already be on the
  // contact BEFORE upsertOpportunity runs. Writing them afterwards — as this handler did until
  // 2026-08-27 — loses the race every time: 001 sat at zero enrolments from the 08-21 publish
  // until the first real lead came through and was rejected with
  // "Filter not matched - Tag · actual [jo-partial] · expected rt-jacob".
  // Do not move these below the opportunity call, and do not make them fire-and-forget.
  const gateOps = [];

  gateOps.push(removeTag(env, contactId, TAG_PARTIAL).catch(() => {}));

  const intentTag = INTENT_TAGS[cleanString(p.intent)];
  if (intentTag) gateOps.push(addTag(env, contactId, intentTag));

  // rt-jacob is the entry gate for workflow 001. With only one route tag left, a
  // re-submission that stops qualifying must REMOVE it, not just fail to add it —
  // otherwise a lead who downgrades their timeline stays enrolled in Jacob's nurture.
  if (route.type === 'jacob') gateOps.push(addTag(env, contactId, TAG_JACOB));
  else gateOps.push(removeTag(env, contactId, TAG_JACOB).catch(() => {}));

  // Overflow-caused team routing gets a distinct tag — Jacob's "revenue I gave away while slammed" view.
  if (route.overflow) gateOps.push(addTag(env, contactId, TAG_OVERFLOW));
  else gateOps.push(removeTag(env, contactId, TAG_OVERFLOW).catch(() => {}));

  reportSettled('Gate tag op', await Promise.allSettled(gateOps));

  // Jacob leads → "New Lead"; team leads → "Routed to AttractZen" (created directly there so
  // they never pass through Jacob's funnel stages and never pollute his conversion metrics).
  const stageId = route.type === 'jacob' ? STAGE_NEW : STAGE_TEAM;
  const oppR = await upsertOpportunity(env, {
    payload: p, contactId,
    opportunityId: sanitizeGhlId(p.opportunityId),
    assignedTo, stageId,
  });

  if (!oppR.ok) {
    console.error('Full submit opp failed:', JSON.stringify(oppR.payload));
    return jsonResponse({ ok: false, error: 'Failed to update opportunity' }, 502, corsHeaders);
  }

  const opportunityId = sanitizeGhlId(oppR.payload?.opportunity?.id);

  // Everything below is read by humans, not by a trigger, so it can settle after the enrolment.
  const trailingOps = [];

  if (assignedTo) {
    trailingOps.push(
      ghlRequest(env, 'PUT', `/contacts/${contactId}`, { body: { assignedTo } }).catch(() => {})
    );
  }

  trailingOps.push(addNote(env, contactId, buildSubmitNote(p, route)));

  reportSettled('Trailing op', await Promise.allSettled(trailingOps));

  const teamHandoffUrl = await readCustomValue(env, CV_TEAM_URL_ID).catch(() => '');

  return jsonResponse({
    ok: true,
    contactId,
    opportunityId,
    route: {
      type: route.type,
      calendarId: route.type === 'jacob' ? JACOB_CAL_ID : null,
      teamHandoffUrl: route.type === 'team' ? teamHandoffUrl : null,
      reason: route.reason,
    },
  }, 200, corsHeaders);
}

async function handleBookAppointment(request, env, corsHeaders) {
  if (isBodyTooLarge(request)) return jsonResponse({ error: 'Body too large' }, 413, corsHeaders);
  const p = await safeReadJson(request);
  const err = validateBookingPayload(p);
  if (err) return jsonResponse({ ok: false, error: err }, 400, corsHeaders);

  // Upsert contact (idempotent)
  const contactR = await upsertContact(env, p);
  if (!contactR.ok) {
    console.error('Booking contact failed:', JSON.stringify(contactR.payload));
    return jsonResponse({ ok: false, error: 'Failed to upsert contact' }, 502, corsHeaders);
  }

  const contactId = sanitizeGhlId(contactR.payload?.contact?.id);
  if (!contactId) return jsonResponse({ ok: false, error: 'No contact id' }, 502, corsHeaders);

  // Idempotency check
  const startTime = getBookingStartTime(p);
  const calendarId = sanitizeGhlId(p.calendarId) || JACOB_CAL_ID;
  const dedupKey = `${contactId}:${calendarId}:${startTime}`;
  const now = Date.now();
  const existingTs = BOOKING_DEDUP.get(dedupKey);
  if (existingTs && (now - existingTs) < BOOKING_DEDUP_TTL_MS) {
    return jsonResponse({ ok: false, error: 'Duplicate booking request' }, 409, corsHeaders);
  }
  BOOKING_DEDUP.set(dedupKey, now);
  for (const [k, ts] of BOOKING_DEDUP) {
    if (now - ts > BOOKING_DEDUP_TTL_MS) BOOKING_DEDUP.delete(k);
  }
  if (BOOKING_DEDUP.size > BOOKING_DEDUP_MAX_SIZE) {
    let removed = 0;
    for (const k of BOOKING_DEDUP.keys()) {
      if (removed >= BOOKING_DEDUP.size - BOOKING_DEDUP_MAX_SIZE) break;
      BOOKING_DEDUP.delete(k);
      removed++;
    }
  }

  // Look up opportunity
  let opportunityId = sanitizeGhlId(p.opportunityId);
  if (!opportunityId) {
    const existing = await findOpenOpportunity(env, contactId);
    if (existing) opportunityId = cleanString(existing.id);
  }

  const timezone = cleanString(p?.bookedSlot?.timezone || p?.slot?.timezone || p?.timezone) || 'America/Los_Angeles';

  // Create appointment (can take ~90s)
  const bookingR = await ghlRequest(env, 'POST', '/calendars/events/appointments', {
    body: {
      locationId: LOCATION_ID,
      calendarId,
      contactId,
      startTime,
      selectedTimezone: timezone,
      timezone,
    },
  });

  if (!bookingR.ok) {
    console.error('Booking failed:', JSON.stringify(bookingR.payload));
    addTag(env, contactId, TAG_BOOKING_FAIL).catch(() => {});
    addNote(env, contactId, buildBookingFailureNote(p, extractErrorMessage(bookingR.payload))).catch(() => {});
    return jsonResponse({
      ok: false,
      error: 'Booking failed',
      message: extractErrorMessage(bookingR.payload, 'Could not book this slot. Please pick another time.'),
      contactId,
      opportunityId,
    }, 502, corsHeaders);
  }

  // Post-booking ops (non-blocking)
  const postOps = [];

  if (opportunityId) {
    postOps.push(
      ghlRequest(env, 'PUT', `/opportunities/${opportunityId}`, {
        body: {
          pipelineStageId: STAGE_BOOKED,
          assignedTo: JACOB_USER_ID,
        },
      }).catch(() => {})
    );
  }

  postOps.push(removeTag(env, contactId, TAG_BOOKING_FAIL).catch(() => {}));
  postOps.push(addNote(env, contactId, buildBookingNote(p)));
  postOps.push(
    ghlRequest(env, 'PUT', `/contacts/${contactId}`, { body: { assignedTo: JACOB_USER_ID } }).catch(() => {})
  );

  const postResults = await Promise.allSettled(postOps);
  postResults.forEach((r, i) => {
    if (r.status === 'rejected') console.error(`Post-booking op ${i} failed:`, r.reason);
  });

  return jsonResponse({
    ok: true,
    message: 'Appointment booked',
    contactId,
    opportunityId,
    appointmentId: cleanString(bookingR.payload?.id || bookingR.payload?.event?.id) || null,
  }, 200, corsHeaders);
}

// ─── Free Slots ───
async function handleFreeSlots(url, env, corsHeaders) {
  const calendarId = sanitizeGhlId(url.searchParams.get('calendarId') || '') || JACOB_CAL_ID;
  const startRaw = url.searchParams.get('startDate');
  const endRaw = url.searchParams.get('endDate');
  const timezone = cleanString(url.searchParams.get('timezone') || '') || 'America/Los_Angeles';

  if (!startRaw || !endRaw)
    return jsonResponse({ error: 'startDate and endDate required' }, 400, corsHeaders);

  const startMs = parseDateMs(startRaw);
  const endMs = parseDateMs(endRaw);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs))
    return jsonResponse({ error: 'Invalid date format' }, 400, corsHeaders);

  const apiKey = cleanString(env.GHL_API_TOKEN);
  const publicSlots = await requestPublicFreeSlots(calendarId, startMs, endMs, timezone);

  if (publicSlots.ok) return jsonResponse(publicSlots.payload, 200, corsHeaders);

  if (apiKey) {
    const privateSlots = await requestPrivateFreeSlots(apiKey, calendarId, startMs, endMs, timezone);
    if (privateSlots.ok) return jsonResponse(privateSlots.payload, 200, corsHeaders);
    console.error('Free slots failed:', JSON.stringify({ public: publicSlots.payload, private: privateSlots.payload }));
  }

  return jsonResponse({ error: 'Could not load calendar slots' }, 502, corsHeaders);
}

function parseDateMs(v) {
  const s = String(v || '').trim();
  if (!s) return NaN;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return NaN;
    return Math.abs(n) >= 1e12 ? Math.floor(n) : Math.floor(n * 1000);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00.000Z').getTime();
  const p = new Date(s).getTime();
  return Number.isFinite(p) ? p : NaN;
}

async function requestPublicFreeSlots(calendarId, startMs, endMs, timezone) {
  const params = new URLSearchParams({
    startDate: String(startMs),
    endDate: String(endMs),
    sendSeatsPerSlot: 'false',
  });
  if (timezone) params.set('timezone', timezone);

  const resp = await fetch(`${GHL_PUBLIC_BASE_URL}/calendars/${calendarId}/free-slots?${params}`);
  const payload = await readResponsePayload(resp);
  return { ok: resp.ok, status: resp.status, payload };
}

async function requestPrivateFreeSlots(apiKey, calendarId, startMs, endMs, timezone) {
  const params = new URLSearchParams({
    startDate: String(Math.floor(startMs / 1000)),
    endDate: String(Math.floor(endMs / 1000)),
  });
  if (timezone) params.set('timezone', timezone);

  const resp = await fetch(`${GHL_BASE_URL}/calendars/${calendarId}/free-slots?${params}`, {
    headers: buildGhlHeaders(apiKey),
  });
  const payload = await readResponsePayload(resp);
  return { ok: resp.ok, status: resp.status, payload };
}

// ─── Address Autocomplete ───
async function handleAddressAutocomplete(url, env, corsHeaders) {
  const apiKey = cleanString(env.GEOAPIFY_API_KEY);
  if (!apiKey) return jsonResponse({ error: 'Address lookup not configured' }, 500, corsHeaders);

  const text = cleanString(url.searchParams.get('text') || '');
  const country = cleanString(url.searchParams.get('country') || 'us').toLowerCase();
  const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit'), 10) || 5, 10));

  if (text.length < 3) return jsonResponse({ error: 'Search text too short (min 3 chars)' }, 400, corsHeaders);

  const geoUrl = `${GEO_BASE_URL}/autocomplete?text=${encodeURIComponent(text)}&limit=${limit}&filter=countrycode:${country}&apiKey=${apiKey}`;
  const resp = await fetch(geoUrl);
  const payload = await readResponsePayload(resp);

  if (!resp.ok) return jsonResponse({ error: 'Address lookup failed' }, resp.status, corsHeaders);

  const features = (Array.isArray(payload?.features) ? payload.features : []).map(f => ({
    type: 'Feature',
    properties: {
      formatted: f?.properties?.formatted || '',
      address_line1: f?.properties?.address_line1 || '',
      address_line2: f?.properties?.address_line2 || '',
      lat: f?.properties?.lat ?? null,
      lon: f?.properties?.lon ?? null,
    },
    geometry: f?.geometry || null,
  }));

  return jsonResponse({ type: 'FeatureCollection', features }, 200, corsHeaders);
}

// ─── Switch ───
async function handleGetSwitch(env, corsHeaders) {
  const mode = await readCustomValue(env, CV_OVERFLOW_MODE_ID).catch(() => 'off');
  return jsonResponse({ ok: true, mode: mode || 'off' }, 200, corsHeaders);
}

async function handlePostSwitch(request, env, corsHeaders) {
  const switchSecret = cleanString(env.SWITCH_SECRET);
  if (switchSecret) {
    const provided = cleanString(request.headers.get('x-switch-secret'));
    if (provided !== switchSecret) {
      return jsonResponse({ ok: false, error: 'Unauthorized' }, 401, corsHeaders);
    }
  }

  const p = await safeReadJson(request);
  let mode;
  if (p && p.toggle) {
    const current = await readCustomValue(env, CV_OVERFLOW_MODE_ID).catch(() => 'off');
    mode = current === 'on' ? 'off' : 'on';
  } else if (p && (p.mode === 'on' || p.mode === 'off')) {
    mode = p.mode;
  } else {
    return jsonResponse({ ok: false, error: 'Provide mode:"on"|"off" or toggle:true' }, 400, corsHeaders);
  }

  const result = await writeCustomValue(env, CV_OVERFLOW_MODE_ID, mode);
  if (!result.ok) {
    console.error('Switch write failed:', JSON.stringify(result.payload));
    return jsonResponse({ ok: false, error: 'Failed to update switch' }, 502, corsHeaders);
  }

  return jsonResponse({ ok: true, mode }, 200, corsHeaders);
}

// ─── Routing config ───
async function handleGetRoutingConfig(env, corsHeaders) {
  const config = await readRoutingConfig(env).catch(() => normalizeConfig(DEFAULT_ROUTING_CONFIG));
  return jsonResponse({ ok: true, config }, 200, corsHeaders);
}

async function handlePostRoutingConfig(request, env, corsHeaders) {
  const switchSecret = cleanString(env.SWITCH_SECRET);
  if (switchSecret) {
    const provided = cleanString(request.headers.get('x-switch-secret'));
    if (provided !== switchSecret) {
      return jsonResponse({ ok: false, error: 'Unauthorized' }, 401, corsHeaders);
    }
  }

  const p = await safeReadJson(request);
  const incoming = p && p.config;
  const check = validateConfig(incoming);
  if (!check.ok) {
    return jsonResponse({ ok: false, error: check.errors.join('; ') || 'Invalid config' }, 400, corsHeaders);
  }

  const config = normalizeConfig(incoming);
  const result = await writeCustomValue(env, CV_ROUTING_CONFIG_ID, JSON.stringify(config));
  if (!result.ok) {
    console.error('Routing config write failed:', JSON.stringify(result.payload));
    return jsonResponse({ ok: false, error: 'Failed to update routing config' }, 502, corsHeaders);
  }
  return jsonResponse({ ok: true, config }, 200, corsHeaders);
}

// ─── Main Router ───
export default {
  async fetch(request, env) {
    const corsHeaders = buildCorsHeaders(env, request);

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: corsHeaders });

    const url = new URL(request.url);

    try {
      if (url.pathname === '/api/health' && request.method === 'GET')
        return jsonResponse({ ok: true, service: 'jacob-orth-backend' }, 200, corsHeaders);

      if (url.pathname === '/api/free-slots' && request.method === 'GET')
        return await handleFreeSlots(url, env, corsHeaders);

      if (url.pathname === '/api/address/autocomplete' && request.method === 'GET')
        return await handleAddressAutocomplete(url, env, corsHeaders);

      if (url.pathname === '/api/submit/partial' && request.method === 'POST')
        return await handlePartialSubmit(request, env, corsHeaders);

      if (url.pathname === '/api/submit/full' && request.method === 'POST')
        return await handleFullSubmit(request, env, corsHeaders);

      if (url.pathname === '/api/appointments/book' && request.method === 'POST')
        return await handleBookAppointment(request, env, corsHeaders);

      if (url.pathname === '/api/switch' && request.method === 'GET')
        return await handleGetSwitch(env, corsHeaders);

      if (url.pathname === '/api/switch' && request.method === 'POST')
        return await handlePostSwitch(request, env, corsHeaders);

      if (url.pathname === '/api/routing-config' && request.method === 'GET')
        return await handleGetRoutingConfig(env, corsHeaders);

      if (url.pathname === '/api/routing-config' && request.method === 'POST')
        return await handlePostRoutingConfig(request, env, corsHeaders);

      return jsonResponse({ error: 'Not Found' }, 404, corsHeaders);
    } catch (error) {
      console.error('Unhandled worker error:', error?.message, error?.stack);
      return jsonResponse({ error: 'Internal server error' }, 500, corsHeaders);
    }
  },
};
