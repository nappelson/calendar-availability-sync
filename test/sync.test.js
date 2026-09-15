const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const Core = require('../src/Core');
const config = (ids = ['a', 'b', 'c']) => ({ calendars: ids.map(id => ({ id })), daysAhead: 183, includeAllDay: true, includeUnanswered: true, includeTentative: true, maxChangesPerRun: 500 });
const event = (id, extra = {}) => ({ id, summary: 'SECRET', description: 'SECRET', location: 'SECRET', status: 'confirmed', start: { dateTime: '2026-10-10T10:00:00Z' }, end: { dateTime: '2026-10-10T11:00:00Z' }, ...extra });
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const clone = x => JSON.parse(JSON.stringify(x));
function harness(ids = ['a', 'b', 'c']) {
  const db = Object.fromEntries(ids.map(id => [id, []]));
  const props = {}, calls = [], logs = [];
  let locked = false, sequence = 0;
  const h = { db, props, calls, logs, failRead: null, failWrite: false, ambiguousInsert: false, role: 'owner', pageSize: 2, lockBusy: false, triggers: [], filterSemantics: 'every', elapsedMs: 0, writeElapsedMs: 0, readElapsedMs: 0 };
  const context = {
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : ['2026-09-15T16:00:00Z'])); }
      static now() { return Date.parse('2026-09-15T16:00:00Z') + h.elapsedMs; }
    },
    console: { log: x => logs.push(x) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (locked || h.lockBusy) return false; locked = true; return true; }, releaseLock: () => { locked = false; } }) },
    Utilities: { getUuid: () => crypto.randomUUID(), DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_, s) => [...crypto.createHash('sha256').update(s).digest()] },
    ScriptApp: {
      getProjectTriggers: () => h.triggers.slice(),
      deleteTrigger: t => { h.triggers = h.triggers.filter(x => x !== t); },
      newTrigger: name => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => { h.triggers.push({ getHandlerFunction: () => name }); } }) }) })
    },
    Calendar: { Events: {
      list(id, opts) {
        calls.push(['list', id, clone(opts)]);
        h.elapsedMs += h.readElapsedMs;
        if (h.failRead === id || !db[id] || (h.failPage && opts.pageToken)) throw new Error('SECRET API error');
        let events = db[id].filter(e => e.status !== 'cancelled');
        if (opts.privateExtendedProperty) events = events.filter(e => opts.privateExtendedProperty[h.filterSemantics](pair => { const [k, v] = pair.split('='); return e.extendedProperties?.private?.[k] === v; }));
        else if (opts.timeMin) events = events.filter(e => Date.parse(e.end.dateTime || e.end.date) > Date.parse(opts.timeMin) && Date.parse(e.start.dateTime || e.start.date) < Date.parse(opts.timeMax));
        const offset = Number(opts.pageToken || 0), items = clone(events.slice(offset, offset + h.pageSize));
        return { items, accessRole: h.role, ...(offset + h.pageSize < events.length ? { nextPageToken: String(offset + h.pageSize) } : {}) };
      },
      get(id, eid) { h.elapsedMs += h.getElapsedMs || 0; const e = db[id].find(e => e.id === eid); return clone(h.tamper ? { ...e, extendedProperties: {} } : e); },
      insert(body, id, opts) {
        calls.push(['insert', id, clone(body), opts]);
        h.elapsedMs += h.writeElapsedMs;
        if (h.failWrite) throw new Error('SECRET');
        db[id].push({ ...clone(body), id: body.id || 'generated' + sequence++, organizer: { self: true } });
        if (h.ambiguousInsert) { h.ambiguousInsert = false; throw new Error('Request timed out after commit'); }
      },
      update(body, id, eid, opts) { calls.push(['update', id, eid, opts]); if (h.failWrite) throw new Error('SECRET'); db[id][db[id].findIndex(e => e.id === eid)] = { ...clone(body), id: eid, organizer: { self: true } }; },
      remove(id, eid, opts) { calls.push(['delete', id, eid, opts]); h.elapsedMs += h.writeElapsedMs; if (h.failWrite) throw new Error('SECRET'); db[id] = db[id].filter(e => e.id !== eid); }
    } }
  };
  vm.createContext(context);
  for (const file of ['Core', 'CalendarAccess', 'Code']) vm.runInContext(fs.readFileSync(`src/${file}.js`, 'utf8'), context);
  context.SYNC_CONFIG = config(ids);
  h.context = context;
  h.run = () => context.syncCalendars();
  h.preview = () => context.previewSync();
  h.blocks = id => db[id].filter(e => Core.managed(e, props.busySyncOwner));
  return h;
}

test('all-way sync is private, strips details, does not loop, and is idempotent', () => {
  const h = harness(); for (const id of ['a', 'b', 'c']) h.db[id].push(event(id));
  assert.equal(h.run().applied, 6);
  for (const id of ['a', 'b', 'c']) for (const b of h.blocks(id)) {
    assert.equal(b.summary, 'Busy'); assert.equal(b.visibility, 'private'); assert.equal(b.transparency, 'opaque');
    assert.equal(b.description, undefined); assert.equal(b.attendees, undefined); assert.equal(b.location, undefined); assert.equal(b.reminders.useDefault, false);
  }
  assert.equal(h.run().applied, 0);
  assert.ok(!h.logs.join('').includes('SECRET'));
});
test('preview does not mutate calendars or register destinations', () => {
  const h = harness(); h.db.a.push(event('1')); const before = clone(h.db);
  assert.equal(h.preview().planned.insert, 2); assert.deepEqual(h.db, before); assert.equal(h.props.busySyncCalendars, undefined);
});
test('reschedule updates in place and cancellation removes copies only', () => {
  const h = harness(); h.db.a.push(event('1')); h.run(); const id = h.blocks('b')[0].id;
  h.db.a[0].start.dateTime = '2026-10-10T12:00:00Z'; h.db.a[0].end.dateTime = '2026-10-10T13:00:00Z';
  assert.equal(h.run().planned.update, 2); assert.equal(h.blocks('b')[0].id, id);
  h.db.a[0].status = 'cancelled'; assert.equal(h.run().planned.delete, 2); assert.equal(h.db.a.length, 1);
});
test('declined, free, birthday, working location excluded; invite policies configurable', () => {
  const h = harness(); h.db.a.push(event('declined', { attendees: [{ self: true, responseStatus: 'declined' }] }), event('free', { transparency: 'transparent' }), event('birthday', { eventType: 'birthday' }), event('location', { eventType: 'workingLocation' }), event('pending', { attendees: [{ self: true, responseStatus: 'needsAction' }] }), event('maybe', { attendees: [{ self: true, responseStatus: 'tentative' }] }));
  assert.equal(h.run().planned.insert, 4);
  h.context.SYNC_CONFIG.includeUnanswered = false; h.context.SYNC_CONFIG.includeTentative = false;
  assert.equal(h.run().planned.delete, 4);
});
test('recurring instances retain identity when moved, and cancel individually', () => {
  const h = harness(); h.db.a.push(event('series_1', { iCalUID: 'series', originalStartTime: { dateTime: '2026-10-10T10:00:00Z' } }), event('series_2', { iCalUID: 'series', originalStartTime: { dateTime: '2026-10-17T10:00:00Z' }, start: { dateTime: '2026-10-17T10:00:00Z' }, end: { dateTime: '2026-10-17T11:00:00Z' } }));
  h.run(); h.db.a[0].start.dateTime = '2026-10-11T10:00:00Z'; h.db.a[0].end.dateTime = '2026-10-11T11:00:00Z';
  assert.equal(h.run().planned.update, 2);
  h.db.a[1].status = 'cancelled'; assert.equal(h.run().planned.delete, 2); assert.equal(h.blocks('b').length, 1);
});
test('same invitation on two calendars does not create redundant busy blocks', () => {
  const h = harness(); h.db.a.push(event('a1', { iCalUID: 'shared' })); h.db.b.push(event('b1', { iCalUID: 'shared' }));
  assert.equal(h.run().planned.insert, 1); assert.equal(h.blocks('a').length, 0); assert.equal(h.blocks('c').length, 1);
});
test('all-day dates preserved and policy changes remove blocks', () => {
  const h = harness(); h.db.a.push(event('day', { start: { date: '2026-10-10' }, end: { date: '2026-10-12' } })); h.run();
  assert.deepEqual(h.blocks('b')[0].end, { date: '2026-10-12' }); h.context.SYNC_CONFIG.includeAllDay = false; assert.equal(h.run().planned.delete, 2);
});
test('timezone offsets normalize to the same instant across DST', () => {
  const h = harness(); h.db.a.push(event('dst', { start: { dateTime: '2026-11-01T01:30:00-04:00' }, end: { dateTime: '2026-11-01T01:30:00-05:00' } })); h.run();
  const b = h.blocks('b')[0]; assert.equal(Date.parse(b.end.dateTime) - Date.parse(b.start.dateTime), 3600000); assert.equal(h.run().applied, 0);
});
test('read failure on last calendar or later page prevents every write', () => {
  const h = harness(); h.db.a.push(event('1'), event('2'), event('3')); h.run();
  const before = clone(h.db); h.db.a[0].status = 'cancelled'; h.failRead = 'c'; assert.throws(h.run); assert.deepEqual(h.db.b, before.b);
  h.failRead = null; h.failPage = true; h.calls.length = 0; assert.throws(h.run); assert.ok(h.calls.every(c => c[0] === 'list'));
});
test('read-only role prevents writes', () => { const h = harness(); h.role = 'reader'; h.db.a.push(event('1')); assert.throws(h.run); assert.equal(h.blocks('b').length, 0); });
test('add and remove calendar cleans outgoing and incoming blocks, preserves originals', () => {
  const h = harness(['a', 'b']); h.db.a.push(event('a')); h.db.b.push(event('b')); h.run();
  h.db.c = [event('c')]; h.context.SYNC_CONFIG = config(); assert.equal(h.run().planned.insert, 4);
  h.context.SYNC_CONFIG = config(['a', 'c']); const r = h.run(); assert.equal(r.planned.delete, 4);
  assert.equal(h.db.b.length, 1); assert.equal(h.db.b[0].id, 'b'); assert.deepEqual(JSON.parse(h.props.busySyncCalendars), ['a', 'c']);
});
test('lost access on removed calendar blocks cleanup and preserves registry for retry', () => {
  const h = harness(); h.db.a.push(event('1')); h.run(); h.context.SYNC_CONFIG = config(['a', 'b']); h.failRead = 'c'; assert.throws(h.run);
  assert.ok(JSON.parse(h.props.busySyncCalendars).includes('c')); h.failRead = null; h.run(); assert.equal(h.blocks('c').length, 0);
});
test('ambiguous insert failure recovers without duplicate on next run', () => {
  const h = harness(); h.db.a.push(event('1')); h.ambiguousInsert = true; assert.throws(h.run); assert.ok(h.props.busySyncCalendars);
  h.run(); assert.equal(h.blocks('b').length, 1); assert.equal(h.blocks('c').length, 1); assert.equal(h.run().applied, 0);
});
test('existing duplicates reconcile down to one', () => {
  const h = harness(); h.db.a.push(event('1')); h.run(); h.db.b.push({ ...clone(h.blocks('b')[0]), id: 'duplicate' });
  assert.equal(h.run().planned.delete, 1); assert.equal(h.blocks('b').length, 1);
});
test('mutation ownership rechecked, original Busy titles are never ownership evidence', () => {
  const h = harness(); h.db.a.push(event('original', { summary: 'Busy' })); h.run(); h.db.a[0].status = 'cancelled'; h.tamper = true;
  assert.throws(h.run); assert.equal(h.blocks('b').length, 1); assert.equal(h.db.a[0].id, 'original');
});
test('change limit rejects entire plan before writes; counts remain reviewable', () => {
  const h = harness(); h.db.a.push(event('1')); h.context.SYNC_CONFIG.maxChangesPerRun = 1; assert.throws(h.run);
  assert.equal(h.blocks('b').length, 0); assert.equal(JSON.parse(h.props.busySyncStatus).planned.insert, 2);
});
test('cleanup removes only this installation blocks including retired and past blocks', () => {
  const h = harness(); h.db.a.push(event('1')); h.run(); const original = clone(h.db.a[0]);
  const foreign = clone(h.blocks('b')[0]); foreign.id = 'foreign'; foreign.extendedProperties.private.busySyncOwner = 'someone-else'; h.db.b.push(foreign);
  const before = clone(h.db); h.context.previewCleanup(); assert.deepEqual(h.db, before);
  h.context.cleanupAllBlocks(); assert.deepEqual(h.db.a, [original]); assert.deepEqual(h.db.b, [foreign]); assert.equal(h.db.c.length, 0);
});
test('empty/duplicate/alias configuration rejected, explicit cleanup remains available', () => {
  const h = harness(); h.context.SYNC_CONFIG = config([]); assert.throws(h.run); assert.equal(h.context.cleanupAllBlocks().ok, true);
  for (const ids of [['a', 'a'], ['primary'], [' a']]) assert.throws(() => Core.validate(config(ids)));
});
test('rolling window drops expired copies and events moved beyond horizon', () => {
  const h = harness(); h.db.a.push(event('1')); h.run(); h.db.a[0].start.dateTime = '2028-10-10T10:00:00Z'; h.db.a[0].end.dateTime = '2028-10-10T11:00:00Z';
  assert.equal(h.run().planned.delete, 2);
});
test('no API mutation requests invite notifications', () => {
  const h = harness(); h.db.a.push(event('1')); h.run(); h.db.a[0].status = 'cancelled'; h.run();
  for (const c of h.calls.filter(c => c[0] !== 'list')) assert.equal(c.at(-1).sendUpdates, 'none');
});

test('changed copy with attendees is preserved for manual inspection', () => {
  const h = harness(); h.db.a.push(event('1')); h.run(); h.blocks('b')[0].attendees = [{ email: 'guest@example.com' }];
  assert.throws(h.run); assert.equal(h.blocks('b')[0].attendees.length, 1);
});
test('failure status retains last successful timestamp and safe failure stage', () => {
  const h = harness(); h.run(); const success = JSON.parse(h.props.busySyncStatus).lastSuccessfulSyncAt;
  h.failRead = 'c'; assert.throws(h.run); const status = JSON.parse(h.props.busySyncStatus);
  assert.equal(status.lastSuccessfulSyncAt, success); assert.equal(status.stage, 'read calendar 3 of 3'); assert.equal(status.ok, false);
  assert.ok(!JSON.stringify(status).includes('SECRET'));
});
test('malformed source aborts before modifications', () => {
  const h = harness(); h.db.a.push(event('bad', { start: { dateTime: 'not a date' } }));
  // Test the pure planner directly: a provider would normally reject this date.
  const snapshots = { a: { events: h.db.a, managed: [] }, b: { events: [], managed: [] }, c: { events: [], managed: [] } };
  assert.throws(() => Core.plan(config(), snapshots, 'owner', hash));
});
test('many successive mutations converge and never change originals', () => {
  const h = harness(); let seed = 12345;
  function random(n) { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; }
  for (let i = 0; i < 80; i++) {
    const cal = ['a', 'b', 'c'][random(3)];
    const originals = h.db[cal].filter(e => !Core.managed(e, h.props.busySyncOwner));
    const chosen = originals[random(originals.length || 1)];
    if (!chosen || random(3) === 0) h.db[cal].push(event('original' + i));
    else if (random(2)) chosen.status = 'cancelled';
    else { chosen.start.dateTime = '2026-10-11T13:00:00Z'; chosen.end.dateTime = '2026-10-11T14:00:00Z'; }
    const before = Object.fromEntries(['a', 'b', 'c'].map(id => [id, clone(h.db[id].filter(e => !Core.managed(e, h.props.busySyncOwner)))]));
    h.run(); assert.equal(h.run().applied, 0);
    for (const id of ['a', 'b', 'c']) {
      assert.deepEqual(h.db[id].filter(e => !Core.managed(e, h.props.busySyncOwner)), before[id]);
      const expected = ['a', 'b', 'c'].filter(x => x !== id).reduce((n, x) => n + before[x].filter(e => e.status !== 'cancelled').length, 0);
      assert.equal(h.blocks(id).length, expected);
    }
  }
});
test('Google omitting default opaque transparency does not cause repeated writes', () => {
  const h = harness(); h.db.a.push(event('1')); h.run();
  for (const id of ['b', 'c']) delete h.blocks(id)[0].transparency;
  assert.equal(h.run().applied, 0);
});

test('conflicting invitation times protect both intervals and converge after agreement', () => {
  const h = harness();
  h.db.a.push(event('a1', { iCalUID: 'shared' }));
  h.db.b.push(event('b1', { iCalUID: 'shared', start: { dateTime: '2026-10-10T12:00:00Z' }, end: { dateTime: '2026-10-10T13:00:00Z' } }));
  h.run();
  assert.equal(h.blocks('a')[0].start.dateTime, '2026-10-10T12:00:00.000Z');
  assert.equal(h.blocks('b')[0].start.dateTime, '2026-10-10T10:00:00.000Z');
  assert.equal(h.blocks('c').length, 2);
  assert.equal(h.run().applied, 0);
  h.db.a[0].start = clone(h.db.b[0].start); h.db.a[0].end = clone(h.db.b[0].end);
  h.run();
  assert.equal(h.blocks('a').length, 0); assert.equal(h.blocks('b').length, 0);
  assert.equal(h.blocks('c').length, 1); assert.equal(h.blocks('c')[0].start.dateTime, '2026-10-10T12:00:00.000Z');
  assert.equal(h.run().applied, 0);
});
test('same recurring occurrence with different end times retains both versions', () => {
  const h = harness();
  const shared = { iCalUID: 'series', originalStartTime: { dateTime: '2026-10-10T10:00:00Z' } };
  h.db.a.push(event('a1', shared));
  h.db.b.push(event('b1', { ...shared, end: { dateTime: '2026-10-10T12:00:00Z' } }));
  h.run(); assert.equal(h.blocks('c').length, 2);
  assert.equal(h.blocks('a')[0].end.dateTime, '2026-10-10T12:00:00.000Z');
});
test('equal invitation intervals with different timezone offsets still deduplicate', () => {
  const h = harness();
  h.db.a.push(event('a1', { iCalUID: 'same' }));
  h.db.b.push(event('b1', { iCalUID: 'same', start: { dateTime: '2026-10-10T06:00:00-04:00' }, end: { dateTime: '2026-10-10T07:00:00-04:00' } }));
  assert.equal(h.run().planned.insert, 1); assert.equal(h.run().applied, 0);
});
test('cleanup lock contention leaves scheduling and blocks intact, then retry succeeds', () => {
  const h = harness(); h.db.a.push(event('1')); h.run(); h.context.installSync();
  const before = clone(h.db), status = h.props.busySyncStatus;
  h.lockBusy = true;
  assert.throws(() => h.context.cleanupAllBlocks(), /retry after the active run/);
  assert.equal(h.triggers.length, 1); assert.deepEqual(h.db, before); assert.equal(h.props.busySyncStatus, status);
  h.lockBusy = false;
  assert.equal(h.context.cleanupAllBlocks().ok, true);
  assert.equal(h.triggers.length, 0); assert.equal(h.blocks('b').length, 0); assert.equal(h.blocks('c').length, 0);
  assert.equal(h.db.a[0].id, '1');
});
test('cleanup preview and failed preflight leave scheduling intact', () => {
  const h = harness(); h.db.a.push(event('1')); h.run(); h.context.installSync();
  h.context.previewCleanup(); assert.equal(h.triggers.length, 1);
  h.failRead = 'c'; assert.throws(() => h.context.cleanupAllBlocks()); assert.equal(h.triggers.length, 1);
  h.failRead = null; h.context.SYNC_CONFIG.maxChangesPerRun = 1;
  assert.throws(() => h.context.cleanupAllBlocks()); assert.equal(h.triggers.length, 1);
});
for (const semantics of ['every', 'some']) {
  test(`foreign metadata is ignored under ${semantics === 'every' ? 'AND' : 'OR'} filter semantics`, () => {
    const h = harness(); h.filterSemantics = semantics;
    h.db.a.push(event('1')); h.run();
    const otherOwner = clone(h.blocks('b')[0]); otherOwner.id = 'foreign-owner'; otherOwner.extendedProperties.private.busySyncOwner = 'someone-else';
    const otherApp = clone(h.blocks('b')[0]); otherApp.id = 'foreign-app'; otherApp.extendedProperties.private.busySyncApp = 'another-app'; otherApp.transparency = 'transparent';
    h.db.b.push(otherOwner, otherApp);
    assert.equal(h.run().applied, 0);
    h.context.cleanupAllBlocks();
    assert.deepEqual(h.db.b, [otherOwner, otherApp]);
    for (const call of h.calls.filter(c => c[0] === 'list' && c[2].privateExtendedProperty)) {
      assert.deepEqual(call[2].privateExtendedProperty, ['busySyncOwner=' + h.props.busySyncOwner]);
    }
  });
}

test('hub receives details while every other destination stays Busy-only without propagation', () => {
  const h = harness(); h.context.SYNC_CONFIG.hubCalendarId = 'a';
  h.db.a.push(event('personal', { summary: 'Dentist' }));
  h.db.b.push(event('work', { summary: 'Work meeting', htmlLink: 'https://calendar.google.com/event?eid=123', hangoutLink: 'https://meet.google.com/example', conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/example' }] }, attendees: [{ email: 'guest@example.com' }] }));
  h.run();
  const detail = h.blocks('a')[0];
  assert.equal(detail.summary, 'Work meeting'); assert.equal(detail.location, 'SECRET');
  assert.ok(detail.description.includes('SECRET')); assert.ok(detail.description.includes('https://meet.google.com/example'));
  assert.ok(detail.description.includes('https://calendar.google.com/event?eid=123'));
  assert.equal(detail.attendees, undefined); assert.equal(detail.conferenceData, undefined);
  for (const id of ['b', 'c']) for (const copy of h.blocks(id)) {
    assert.equal(copy.summary, 'Busy'); assert.equal(copy.description, undefined); assert.equal(copy.location, undefined);
  }
  assert.equal(h.run().applied, 0); assert.equal(h.blocks('c').length, 2);
  assert.ok(!h.logs.join('').includes('SECRET'));
});
test('enabling hub upgrades existing blocks in place; detail-only changes and removals reconcile', () => {
  const h = harness(); h.db.b.push(event('work')); h.run(); const id = h.blocks('a')[0].id;
  h.context.SYNC_CONFIG.hubCalendarId = 'a';
  assert.equal(h.run().planned.update, 1); assert.equal(h.blocks('a')[0].id, id);
  h.db.b[0].summary = 'Changed'; h.db.b[0].description = 'New description'; h.db.b[0].location = 'New location';
  assert.equal(h.run().planned.update, 1); assert.equal(h.blocks('a')[0].description, 'Source calendar: b<br><br>New description');
  delete h.db.b[0].description; delete h.db.b[0].location;
  assert.equal(h.run().planned.update, 1); assert.equal(h.blocks('a')[0].description, 'Source calendar: b'); assert.equal(h.blocks('a')[0].location, '');
  assert.equal(h.run().applied, 0);
});
test('changing or disabling hub scrubs details from previous hub, cleanup remains usable', () => {
  const h = harness(); h.context.SYNC_CONFIG.hubCalendarId = 'a'; h.db.b.push(event('work')); h.run();
  h.context.SYNC_CONFIG.hubCalendarId = 'c'; h.run();
  assert.equal(h.blocks('a')[0].summary, 'Busy'); assert.equal(h.blocks('a')[0].description, undefined);
  assert.equal(h.blocks('c')[0].summary, 'SECRET');
  h.context.SYNC_CONFIG.hubCalendarId = null; h.run();
  assert.equal(h.blocks('c')[0].summary, 'Busy'); assert.equal(h.blocks('c')[0].location, undefined);
  h.context.SYNC_CONFIG.hubCalendarId = 'a'; h.run(); h.context.cleanupAllBlocks();
  assert.equal(h.blocks('a').length, 0); assert.equal(h.db.b[0].id, 'work');
});
test('invalid hub IDs fail before writes', () => {
  for (const hub of ['missing', '', 'primary', 123]) {
    const h = harness(); h.context.SYNC_CONFIG.hubCalendarId = hub; h.db.b.push(event('1'));
    assert.throws(h.run); assert.ok(!h.calls.some(c => c[0] === 'insert'));
  }
});

test('permission diagnostics identify readable calendar and required sharing without details', () => {
  const h = harness(); h.role = 'reader';
  assert.throws(h.preview, /readable but lacks write access/);
  const status = JSON.parse(h.props.busySyncStatus);
  assert.equal(status.accessRole, 'reader'); assert.equal(status.calendarConfigIndex, 1);
  assert.ok(!h.logs.join('').includes('SECRET')); assert.equal(status.applied, 0);
});
test('provider diagnostics classify errors without exposing raw messages', () => {
  const h = harness();
  for (const [message, expected] of [
    ['Not Found SECRET', /not found/], ['Forbidden SECRET', /denied access/],
    ['Rate Limit Exceeded SECRET', /rate limit/], ['Unauthorized SECRET', /authorization/],
    ['Backend Error SECRET', /temporarily/], ['Unrecognized SECRET', /Run stopped/]
  ]) {
    const safe = h.context.safeSyncError_(new Error(message));
    assert.match(safe, expected); assert.ok(!safe.includes('SECRET'));
  }
});


test('loop prevention holds for two through eight calendars and every hub destination', () => {
  for (let size = 2; size <= 8; size++) {
    const ids = Array.from({ length: size }, (_, i) => 'calendar-' + i);
    const h = harness(ids);
    for (const id of ids) h.db[id].push(event('original-' + id));
    assert.equal(h.run().planned.insert, size * (size - 1));
    for (const hub of [...ids, null]) {
      h.context.SYNC_CONFIG.hubCalendarId = hub;
      h.run();
      for (let repeat = 0; repeat < 3; repeat++) assert.equal(h.run().applied, 0);
      for (const id of ids) {
        assert.equal(h.db[id].length, size);
        assert.equal(h.blocks(id).length, size - 1);
        assert.deepEqual(h.db[id].find(e => e.id === 'original-' + id), event('original-' + id));
        for (const copy of h.blocks(id)) {
          assert.equal(copy.summary, id === hub ? 'SECRET' : 'Busy');
          if (id === hub) assert.match(copy.description, /^Source calendar: calendar-\d<br><br>SECRET$/);
          else assert.equal(copy.description, undefined);
        }
      }
    }
  }
});

test('copies from another installation of this script never become sources', () => {
  const h = harness();
  h.db.a.push(event('original'));
  h.run();
  const foreign = clone(h.blocks('b')[0]);
  foreign.id = 'other-installation';
  foreign.extendedProperties.private.busySyncOwner = 'other-owner';
  h.db.c.push(foreign);
  h.db.a = [];
  h.run();
  assert.equal(h.db.a.length, 0);
  assert.equal(h.db.b.length, 0);
  assert.deepEqual(h.db.c, [foreign]);
  assert.equal(h.run().applied, 0);
});


test('hub source labels are escaped, refreshed in place, and never leak into Busy destinations', () => {
  const h = harness();
  h.context.SYNC_CONFIG.hubCalendarId = 'a';
  h.context.SYNC_CONFIG.calendars[1].label = 'Client & <Team>';
  h.db.b.push(event('work', { description: '<p>Agenda</p>' }));
  h.run();
  const copyId = h.blocks('a')[0].id;
  assert.equal(h.blocks('a')[0].description, 'Source calendar: Client &amp; &lt;Team&gt;<br><br><p>Agenda</p>');
  assert.equal(h.blocks('c')[0].description, undefined);
  assert.equal(h.run().applied, 0);
  h.context.SYNC_CONFIG.calendars[1].label = 'New client name';
  const result = h.run();
  assert.equal(result.planned.update, 1);
  assert.equal(result.planned.insert, 0);
  assert.equal(h.blocks('a')[0].id, copyId);
  assert.equal(h.blocks('a')[0].description, 'Source calendar: New client name<br><br><p>Agenda</p>');
  h.context.SYNC_CONFIG.calendars[1].label = '   ';
  h.run();
  assert.equal(h.blocks('a')[0].description, 'Source calendar: b<br><br><p>Agenda</p>');
  assert.equal(h.run().applied, 0);
  assert.equal(h.blocks('c')[0].description, undefined);
  assert.equal(h.db.b[0].description, '<p>Agenda</p>');
});


test('initial sync pauses at its write budget and resumes from fresh events without duplicates', () => {
  const h = harness();
  h.db.a.push(event('first'), event('second'));
  h.writeElapsedMs = 110000;
  const partial = h.run();
  assert.equal(partial.ok, true);
  assert.equal(partial.complete, false);
  assert.equal(partial.stage, 'partial');
  assert.equal(partial.applied, 2);
  assert.equal(partial.remaining, 2);
  assert.equal(partial.lastSuccessfulSyncAt, null);
  assert.deepEqual(JSON.parse(h.props.busySyncCalendars), ['a', 'b', 'c']);
  // Source changes between runs must supersede the abandoned plan.
  h.db.a[0].start.dateTime = '2026-10-10T12:00:00Z';
  h.db.a[0].end.dateTime = '2026-10-10T13:00:00Z';
  h.writeElapsedMs = 0;
  const complete = h.run();
  assert.equal(complete.complete, true);
  assert.ok(complete.lastSuccessfulSyncAt);
  for (const id of ['b', 'c']) {
    assert.equal(h.blocks(id).length, 2);
    assert.ok(h.blocks(id).some(e => e.start.dateTime === '2026-10-10T12:00:00.000Z'));
  }
  assert.equal(h.run().applied, 0);
});

test('partial cleanup retains destinations and last successful sync until cleanup finishes', () => {
  const h = harness();
  h.db.a.push(event('first'), event('second'));
  const prior = h.run().lastSuccessfulSyncAt;
  h.context.SYNC_CONFIG.calendars.pop();
  h.writeElapsedMs = 110000;
  const partial = h.context.cleanupAllBlocks();
  assert.equal(partial.complete, false);
  assert.equal(partial.remaining, 2);
  assert.equal(partial.lastSuccessfulSyncAt, prior);
  assert.ok(JSON.parse(h.props.busySyncCalendars).includes('c'));
  h.writeElapsedMs = 0;
  assert.equal(h.context.cleanupAllBlocks().complete, true);
  assert.deepEqual(JSON.parse(h.props.busySyncCalendars), []);
  assert.equal(h.blocks('b').length + h.blocks('c').length, 0);
  assert.equal(h.db.a.length, 2);
});

test('time budget exhaustion during reads still fails closed without calendar writes', () => {
  const h = harness();
  h.db.a.push(event('first'));
  h.readElapsedMs = 130000;
  assert.throws(h.run, /time budget/);
  assert.equal(h.calls.filter(call => call[0] !== 'list').length, 0);
  assert.equal(JSON.parse(h.props.busySyncStatus).ok, false);
});


test('a slow ownership recheck pauses before mutation and preserves the prior success time', () => {
  const h = harness();
  h.db.a.push(event('first'));
  const prior = h.run().lastSuccessfulSyncAt;
  h.db.a[0].start.dateTime = '2026-10-10T12:00:00Z';
  h.db.a[0].end.dateTime = '2026-10-10T13:00:00Z';
  h.getElapsedMs = 211000;
  const partial = h.run();
  assert.equal(partial.complete, false);
  assert.equal(partial.applied, 0);
  assert.equal(partial.remaining, 2);
  assert.equal(partial.lastSuccessfulSyncAt, prior);
  h.getElapsedMs = 0;
  assert.equal(h.run().applied, 2);
  assert.equal(h.run().applied, 0);
});
