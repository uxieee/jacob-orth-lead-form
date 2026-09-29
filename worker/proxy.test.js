import { describe, it, expect } from 'vitest';
import { buildOpportunityCustomFields } from './proxy.js';

const F = {
  leadIntent:  'N1Hwt3BITgBTVfO7aUWa',
  timeline:    'moPLFSSpXwAAwAtdThos',
  priceRange:  'LIZiAYE7aEjgNeUb14lQ',
  preApproval: 'oHQwLfLsdiliSm8qLx5W',
  routedTo:    'bLSNGJe2ntvkzToHVI4O',
  movingFrom:  'qaQOXMKWE1cTj3SunKW8',
  buyTimeline: 'ZM966WyYREEP5ok81ZlF',
  // Real IDs, created 2026-08-20 (Task 0.1).
  propertyAddress: 'U8Va2mYkWoWFy5yN1B1T',
  leadComments:    '01Wr8IK2QhWAHLV9UHnH',
};

const idsOf = (f) => f.map((x) => x.id);
const valueOf = (f, id) => f.find((x) => x.id === id)?.field_value;

describe('buildOpportunityCustomFields — per-intent coverage (spec §3.3)', () => {
  it('buy writes intent, timeline, price, pre-approval, movingFrom, routedTo', () => {
    const f = buildOpportunityCustomFields({
      intent: 'buy', timeline: 'As soon as possible', priceRange: '$250k - $500k',
      preApproval: 'No - please connect me', movingFrom: 'California',
    }, 'Jacob');
    expect(idsOf(f)).toEqual(expect.arrayContaining([
      F.leadIntent, F.timeline, F.priceRange, F.preApproval, F.movingFrom, F.routedTo,
    ]));
    expect(idsOf(f)).not.toContain(F.buyTimeline);
    expect(idsOf(f)).not.toContain(F.propertyAddress);
    expect(valueOf(f, F.leadIntent)).toBe('Buy a home');
    expect(valueOf(f, F.routedTo)).toBe('Jacob');
  });

  it('rent-short adds buyTimeline', () => {
    const f = buildOpportunityCustomFields({
      intent: 'rent-short', timeline: 'Sooner than 3 months', priceRange: '$250k - $500k',
      preApproval: 'Yes - pre-approval in hand', movingFrom: 'Illinois', buyTimeline: '6 to 12 months',
    }, 'Jacob');
    expect(valueOf(f, F.buyTimeline)).toBe('6 to 12 months');
    expect(valueOf(f, F.leadIntent)).toBe('Rent short-term (then buy soon)');
  });

  it('sell writes the property address to a real field, not just a note', () => {
    const f = buildOpportunityCustomFields({
      intent: 'sell', timeline: '3 to 6 months',
      propertyAddress: '1234 Green Valley Pkwy, Henderson, NV 89014',
    }, 'Team');
    expect(valueOf(f, F.propertyAddress)).toBe('1234 Green Valley Pkwy, Henderson, NV 89014');
    expect(idsOf(f)).not.toContain(F.priceRange);
    expect(idsOf(f)).not.toContain(F.preApproval);
  });

  it('rent-long writes intent, routedTo and comments — comments is all we get', () => {
    const f = buildOpportunityCustomFields({
      intent: 'rent-long',
      comments: 'Looking for a 2 bed near Summerlin, moving for work in the spring.',
    }, 'Team');
    expect(valueOf(f, F.leadComments))
      .toBe('Looking for a 2 bed near Summerlin, moving for work in the spring.');
    expect(idsOf(f)).not.toContain(F.timeline);
  });

  it('comments are written on every intent', () => {
    for (const intent of ['buy', 'sell', 'rent-short', 'rent-long']) {
      const f = buildOpportunityCustomFields({ intent, comments: 'hello' }, 'Jacob');
      expect(valueOf(f, F.leadComments)).toBe('hello');
    }
  });

  it('omits empty values entirely rather than writing blanks', () => {
    const f = buildOpportunityCustomFields({ intent: 'buy' }, 'Jacob');
    expect(idsOf(f)).not.toContain(F.propertyAddress);
    expect(idsOf(f)).not.toContain(F.leadComments);
    expect(idsOf(f)).not.toContain(F.movingFrom);
    for (const x of f) expect(x.field_value).not.toBe('');
  });
});

import { readFileSync } from 'node:fs';

describe('tag cull (rev 3)', () => {
  const src = readFileSync(new URL('./proxy.js', import.meta.url), 'utf8');
  for (const gone of ['jo-submitted', 'jo-booked', 'needs-preapproval', 'rt-team']) {
    it(`no longer applies ${gone}`, () => expect(src).not.toContain(`'${gone}'`));
  }
  for (const kept of ['rt-jacob', 'rt-overflow', 'jo-partial', 'jo-booking-failed',
                      'lead type - buyer', 'lead type - seller',
                      'lead type - renting short term', 'lead type - renter']) {
    it(`still applies ${kept}`, () => expect(src).toContain(`'${kept}'`));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: workflow 001's entry gate (live failure 2026-08-27)
//
// 001 triggers on `opportunity_created` filtered to tag `rt-jacob`. GHL evaluates
// that filter within a second of the opportunity being created, so any tag written
// AFTER the POST /opportunities/ call arrives too late and the lead never enrols.
//
// Live evidence — contact C9Al6rLNTmwUTg3jwzRc (the first real end-to-end submit
// since the 2026-08-21 publish):
//   at:            2026-08-27T17:35:09.060Z   (577ms after the opportunity)
//   qualified:     false
//   failedReason:  Filter not matched - Tag
//   actualValue:   ["jo-partial"]
//   expectedValue: "rt-jacob"
// 001's lifetime enrolment count at that point was 0.
//
// The trigger cannot filter on stage or on a custom field (see the tag-cull note
// above), so the tag IS the gate and ordering is the whole fix.
// ─────────────────────────────────────────────────────────────────────────────

import { afterEach, vi } from 'vitest';
import worker from './proxy.js';

const ENV = { GHL_API_TOKEN: 'test-token', ALLOWED_ORIGINS: '*' };

// Juan Ortiz's actual payload shape — a Jacob-routed buyer.
const JACOB_LEAD = {
  firstName: 'Juan', lastName: 'Ortiz',
  email: 'juan@example.com', phone: '+17025550123',
  intent: 'buy', timeline: 'As soon as possible', priceRange: '$250k - $500k',
  preApproval: 'No - please connect me', movingFrom: 'Outside the U.S.',
};

function stubGhl() {
  const calls = [];
  vi.stubGlobal('fetch', async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, pathname, body });

    const json = (payload) =>
      new Response(JSON.stringify(payload), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });

    if (pathname === '/contacts/upsert') return json({ contact: { id: 'CONTACT1' } });
    if (pathname === '/opportunities/')  return json({ opportunity: { id: 'OPP1' } });
    if (pathname.includes('/customValues/')) return json({ customValue: { value: '' } });
    return json({});
  });
  return calls;
}

const submitFull = (payload) =>
  worker.fetch(
    new Request('https://api.example.com/api/submit/full', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    ENV,
  );

const indexOfTag = (calls, tag) =>
  calls.findIndex((c) => c.method === 'POST' && /\/tags$/.test(c.pathname)
    && Array.isArray(c.body?.tags) && c.body.tags.includes(tag));
const indexOfOppCreate = (calls) =>
  calls.findIndex((c) => c.method === 'POST' && c.pathname === '/opportunities/');

describe("001's entry gate — rt-jacob must exist before the opportunity is created", () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes rt-jacob BEFORE POST /opportunities/', async () => {
    const calls = stubGhl();
    const resp = await submitFull(JACOB_LEAD);
    expect(resp.status).toBe(200);

    const tagAt = indexOfTag(calls, 'rt-jacob');
    const oppAt = indexOfOppCreate(calls);

    expect(tagAt, 'rt-jacob was never written').toBeGreaterThan(-1);
    expect(oppAt, 'no opportunity was created').toBeGreaterThan(-1);
    expect(tagAt).toBeLessThan(oppAt);
  });

  it('writes the lane tag BEFORE POST /opportunities/ too', async () => {
    const calls = stubGhl();
    await submitFull(JACOB_LEAD);
    expect(indexOfTag(calls, 'lead type - buyer')).toBeLessThan(indexOfOppCreate(calls));
  });

  it('still returns the contact and opportunity ids to the form', async () => {
    stubGhl();
    const body = await (await submitFull(JACOB_LEAD)).json();
    expect(body).toMatchObject({ ok: true, contactId: 'CONTACT1', opportunityId: 'OPP1' });
    expect(body.route.type).toBe('jacob');
  });
});

// The partial submit fires FIRST (name/email/phone, before any qualifying question is answered).
// If it creates the opportunity, that is the one and only `opportunity_created` event — the full
// submit then PUTs the same record and no trigger ever fires again. Routing is unknowable at
// partial time, so no tag can be on the contact yet and 001's gate can never be satisfied.
// This is what actually happened to C9Al6rLNTmwUTg3jwzRc: the opportunity was created as
// "Juan Ortiz" at 17:35:08 and only renamed to "Juan Ortiz — Buying" on the full submit.
describe('partial submit must not create the opportunity', () => {
  afterEach(() => vi.unstubAllGlobals());

  const submitPartial = () =>
    worker.fetch(
      new Request('https://api.example.com/api/submit/partial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: 'Juan', lastName: 'Ortiz',
          email: 'juan@example.com', phone: '+17025550123',
        }),
      }),
      ENV,
    );

  it('creates the contact and tags it jo-partial', async () => {
    const calls = stubGhl();
    const resp = await submitPartial();
    expect(resp.status).toBe(202);
    expect(calls.some((c) => c.pathname === '/contacts/upsert')).toBe(true);
    expect(indexOfTag(calls, 'jo-partial')).toBeGreaterThan(-1);
  });

  it('does NOT create an opportunity — that must wait for the full submit', async () => {
    const calls = stubGhl();
    await submitPartial();
    expect(indexOfOppCreate(calls)).toBe(-1);
  });
});

// The full journey, in the order the form actually performs it. This is the regression that
// matters: partial first, then full, and 001's gate tag must land before the only
// `opportunity_created` event in the sequence.
describe('partial → full, the sequence a real lead performs', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('creates exactly one opportunity, and rt-jacob is on the contact before it', async () => {
    const calls = stubGhl();

    const partial = await (await worker.fetch(
      new Request('https://api.example.com/api/submit/partial', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: 'Juan', lastName: 'Ortiz',
          email: 'juan@example.com', phone: '+17025550123',
        }),
      }), ENV)).json();

    // The form threads whatever the partial returned into the full submit.
    await submitFull({ ...JACOB_LEAD, contactId: partial.contactId, opportunityId: partial.opportunityId });

    const creates = calls.filter((c) => c.method === 'POST' && c.pathname === '/opportunities/');
    expect(creates, 'exactly one opportunity_created event').toHaveLength(1);
    expect(creates[0].body.pipelineStageId).toBe('2169701e-c09c-4e43-9566-d61b90fc37cf'); // New Lead
    expect(indexOfTag(calls, 'rt-jacob')).toBeLessThan(indexOfOppCreate(calls));
  });

  it('a team-routed lead never gets rt-jacob, and lands in Not Ready Yet', async () => {
    const calls = stubGhl();
    await submitFull({ ...JACOB_LEAD, intent: 'rent-long', timeline: null, priceRange: null });

    const creates = calls.filter((c) => c.method === 'POST' && c.pathname === '/opportunities/');
    expect(creates).toHaveLength(1);
    expect(creates[0].body.pipelineStageId).toBe('e55e3a80-7c94-431d-b357-2beaee2ebd53'); // Not Ready Yet
    expect(indexOfTag(calls, 'rt-jacob')).toBe(-1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: a returning lead gets their OWN opportunity, and never a 502
// (live failure 2026-08-31T19:22Z — juan@jacobslifeinvegas.com)
//
// A person can buy this year and sell the next. Those are separate deals, so a
// full submit always creates a new opportunity; only a threaded opportunityId
// (same form session) updates in place.
//
// The account setting `allowDuplicateOpportunity` gates whether GHL permits the
// second one. It was OFF until 2026-09-01, which made every re-submission 502:
// no note, no opportunity_created event, no workflow. It is now ON, but the
// recovery path below must survive anyone flipping it back.
// ─────────────────────────────────────────────────────────────────────────────
describe('returning lead — a re-submission is its own deal', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubGhlDuplicates({ duplicateOnCreate } = {}) {
    const calls = [];
    vi.stubGlobal('fetch', async (url, init = {}) => {
      const { pathname } = new URL(url);
      const method = init.method || 'GET';
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method, pathname, body });

      const json = (payload, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

      if (pathname === '/contacts/upsert') return json({ contact: { id: 'CONTACT1' } });
      if (pathname === '/opportunities/' && method === 'POST') {
        if (duplicateOnCreate)
          return json({ statusCode: 400, message: 'Can not create duplicate opportunity for the contact.', code: 'OPPORTUNITY_NO_DUPLICATE', meta: { existingId: 'EXISTING1' } }, 400);
        return json({ opportunity: { id: 'OPP2' } });
      }
      if (pathname.includes('/customValues/')) return json({ customValue: { value: '' } });
      return json({});
    });
    return calls;
  }

  it('creates a NEW opportunity rather than folding into the old one', async () => {
    const calls = stubGhlDuplicates();
    const out = await (await submitFull(JACOB_LEAD)).json();

    expect(out.ok).toBe(true);
    expect(out.opportunityId).toBe('OPP2');
    const creates = calls.filter((c) => c.method === 'POST' && c.pathname === '/opportunities/');
    expect(creates, 'a re-submission is its own deal').toHaveLength(1);
    expect(creates[0].body.pipelineStageId).toBe('2169701e-c09c-4e43-9566-d61b90fc37cf'); // New Lead
    // It must not go looking for an existing record to update.
    expect(calls.some((c) => c.pathname === '/opportunities/search')).toBe(false);
  });

  it('never 502s if allowDuplicateOpportunity is flipped back off', async () => {
    const calls = stubGhlDuplicates({ duplicateOnCreate: true });
    const res = await submitFull(JACOB_LEAD);
    const out = await res.json();

    expect(res.status).toBe(200);
    expect(out.ok).toBe(true);
    expect(out.opportunityId).toBe('EXISTING1');
    const puts = calls.filter((c) => c.method === 'PUT' && c.pathname === '/opportunities/EXISTING1');
    expect(puts).toHaveLength(1);
    // Folding into an existing card must not drag it back to New Lead.
    expect(puts[0].body).not.toHaveProperty('pipelineStageId');
  });

  it('a threaded opportunityId still updates in place — same session, one deal', async () => {
    const calls = stubGhlDuplicates();
    const out = await (await submitFull({ ...JACOB_LEAD, opportunityId: 'SESSION1' })).json();

    expect(out.ok).toBe(true);
    expect(out.opportunityId).toBe('SESSION1');
    expect(calls.filter((c) => c.method === 'POST' && c.pathname === '/opportunities/')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'PUT' && c.pathname === '/opportunities/SESSION1')).toHaveLength(1);
  });
});
