const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const clone = value => JSON.parse(JSON.stringify(value));

function oauthHarness() {
  const props = { GOOGLE_OAUTH_CLIENT_ID: 'client', GOOGLE_OAUTH_CLIENT_SECRET: 'TOP_SECRET' };
  const db = { 'personal@example.com': [], 'work@example.com': [] }, logs = [], calls = [], states = {};
  let locked = false;
  const h = { props, db, logs, calls, states, tokenEmail: 'personal@example.com', tokenScope: 'openid email https://www.googleapis.com/auth/calendar.events', noRefresh: false, refreshFails: false, httpFailure: 0, failWork: false };
  const propertyStore = { getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; }, getProperties: () => ({ ...props }) };
  const lock = { tryLock() { if (locked) return false; locked = true; return true; }, hasLock: () => locked, waitLock() { if (locked) throw Error('lock already held'); locked = true; }, releaseLock() { locked = false; } };
  const response = (code, body) => ({ getResponseCode: () => code, getContentText: () => body === undefined ? '' : JSON.stringify(body) });
  const context = {
    console: { log: s => logs.push(s) },
    SYNC_CONFIG: {},
    PropertiesService: { getScriptProperties: () => propertyStore },
    LockService: { getScriptLock: () => lock },
    Utilities: { getUuid: () => crypto.randomUUID(), DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, computeDigest: (_, s) => [...crypto.createHash('sha256').update(s).digest()] },
    ScriptApp: {
      getScriptId: () => 'script-id', getProjectTriggers: () => [],
      newStateToken() {
        const state = {};
        return { withMethod(method) { state.method = method; return this; }, withArgument(k, v) { state[k] = v; return this; }, withTimeout() { return this; }, createToken() { const id = crypto.randomUUID(); states[id] = state; return id; } };
      }
    },
    HtmlService: { createHtmlOutput: text => text },
    UrlFetchApp: { fetch(url, options) {
      calls.push({ url, options: clone(options) });
      if (url === 'https://oauth2.googleapis.com/token') {
        if (options.payload.grant_type === 'refresh_token') {
          if (h.refreshFails) return response(400, { error: 'invalid_grant', error_description: 'TOP_SECRET' });
          return response(200, { access_token: options.payload.refresh_token.replace('refresh:', 'access:'), expires_in: 3600, scope: h.tokenScope });
        }
        return response(200, { access_token: 'access:' + h.tokenEmail, ...(h.noRefresh ? {} : { refresh_token: 'refresh:' + h.tokenEmail }), expires_in: 3600, scope: h.tokenScope });
      }
      if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return response(200, { email: h.tokenEmail, sub: h.subject || 'sub:' + h.tokenEmail, email_verified: true });
      const u = new URL(url), match = u.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
      if (!match) throw Error('Unexpected URL');
      const id = decodeURIComponent(match[1]), eventId = match[2] && decodeURIComponent(match[2]);
      if (h.httpFailure) return response(h.httpFailure, { error: 'TOP_SECRET' });
      if (h.failWork && id === 'work@example.com') return response(503, { error: 'TOP_SECRET' });
      // Cross-account requests are denied, like accounts with no sharing.
      if (options.headers.Authorization !== 'Bearer access:' + id) return response(403, { error: 'wrong-account TOP_SECRET' });
      if (!db[id]) return response(404, {});
      if (options.method === 'get' && eventId) return response(200, db[id].find(e => e.id === eventId));
      if (options.method === 'get') {
        let items = db[id];
        if (u.searchParams.has('privateExtendedProperty')) {
          const [key, value] = u.searchParams.get('privateExtendedProperty').split('=');
          items = items.filter(e => e.extendedProperties?.private?.[key] === value);
        }
        const offset = Number(u.searchParams.get('pageToken') || 0);
        return response(200, { accessRole: 'owner', items: items.slice(offset, offset + 1), ...(offset + 1 < items.length ? { nextPageToken: String(offset + 1) } : {}) });
      }
      const body = options.payload && JSON.parse(options.payload);
      if (options.method === 'post') { db[id].push({ ...body, organizer: { self: true } }); return response(200, body); }
      if (options.method === 'put') { db[id][db[id].findIndex(e => e.id === eventId)] = { ...body, id: eventId, organizer: { self: true } }; return response(200, body); }
      if (options.method === 'delete') { db[id] = db[id].filter(e => e.id !== eventId); return response(204); }
      throw Error('Unexpected method');
    } }
  };
  vm.createContext(context);
  for (const file of ['OAuth2', 'Auth', 'CalendarAccess', 'Core', 'Code']) vm.runInContext(fs.readFileSync(`src/${file}.js`, 'utf8'), context);
  context.SYNC_CONFIG = {
    authMode: 'oauth', accounts: [{ key: 'personal', email: 'personal@example.com' }, { key: 'work', email: 'work@example.com' }],
    hubCalendarId: 'personal@example.com', calendars: [{ id: 'personal@example.com', account: 'personal' }, { id: 'work@example.com', account: 'work' }],
    daysAhead: 183, maxChangesPerRun: 500, includeAllDay: true, includeUnanswered: true, includeTentative: true
  };
  h.context = context;
  h.begin = key => { props.OAUTH_ACCOUNT_KEY = key; context.showAuthorizationLinks(); return JSON.parse(props['busySyncPending:' + key]); };
  h.finish = (key, pending, params = {}) => context.googleAccountCallback({ parameter: { accountKey: key, nonce: pending.nonce, serviceName: pending.serviceName, code: 'AUTH_CODE_SECRET', ...params } });
  h.connect = key => { h.tokenEmail = key + '@example.com'; return h.finish(key, h.begin(key)); };
  h.connectAll = () => { assert.match(h.connect('personal'), /Account connected/); assert.match(h.connect('work'), /Account connected/); };
  h.expire = key => {
    const record = JSON.parse(props['busySyncAccount:' + key]);
    const tokenKey = Object.keys(props).find(k => k.endsWith(record.serviceName));
    const token = JSON.parse(props[tokenKey]); token.expiresAt = 1; props[tokenKey] = JSON.stringify(token);
    return tokenKey;
  };
  h.event = (id, summary = 'EVENT_SECRET') => ({ id, summary, status: 'confirmed', start: { dateTime: new Date(Date.now() + 86400000).toISOString() }, end: { dateTime: new Date(Date.now() + 90000000).toISOString() } });
  return h;
}

test('actual OAuth2 library creates signed-state links and connects distinct accounts', () => {
  const h = oauthHarness(); h.connectAll();
  const urls = h.logs.filter(s => s.includes('https://accounts.google.com'));
  assert.equal(urls.length, 2);
  for (const line of urls) {
    const u = new URL(line.slice(line.indexOf('https://')));
    assert.equal(u.searchParams.get('access_type'), 'offline');
    assert.equal(u.searchParams.get('redirect_uri'), 'https://script.google.com/macros/d/script-id/usercallback');
    assert.equal(h.states[u.searchParams.get('state')].method, 'googleAccountCallback');
  }
  assert.equal(h.context.connectionStatus().every(s => s.status === 'connected'), true);
  assert.ok(!h.logs.join('').includes('TOP_SECRET')); assert.ok(!h.logs.join('').includes('AUTH_CODE_SECRET'));
});
test('wrong selected account cannot replace a working connection', () => {
  const h = oauthHarness(); h.connect('personal'); const old = h.props['busySyncAccount:personal'];
  const pending = h.begin('personal'); h.tokenEmail = 'work@example.com';
  assert.match(h.finish('personal', pending), /does not match/); assert.equal(h.props['busySyncAccount:personal'], old);
  assert.equal(Object.keys(h.props).some(k => k.endsWith(pending.serviceName)), false);
});
test('denied consent, missing refresh token and missing scope preserve existing account', () => {
  const h = oauthHarness(); h.connect('personal'); const old = h.props['busySyncAccount:personal'];
  assert.match(h.finish('personal', h.begin('personal'), { error: 'access_denied' }), /declined/);
  h.noRefresh = true; assert.match(h.finish('personal', h.begin('personal')), /offline access/);
  h.noRefresh = false; h.tokenScope = 'openid email'; assert.match(h.finish('personal', h.begin('personal')), /Calendar permission/);
  assert.equal(h.props['busySyncAccount:personal'], old);
});
test('callback nonce, stale links and replay rejected before token exchange', () => {
  const h = oauthHarness(); const first = h.begin('personal'), second = h.begin('personal');
  const count = h.calls.length;
  assert.match(h.finish('personal', first), /expired or changed/);
  assert.match(h.finish('personal', second, { nonce: 'wrong' }), /expired or changed/);
  assert.equal(h.calls.length, count);
  assert.match(h.finish('personal', second), /Account connected/);
  const after = h.calls.length; assert.match(h.finish('personal', second), /expired or changed/); assert.equal(h.calls.length, after);
});
test('expired tokens refresh automatically using actual OAuth2 library', () => {
  const h = oauthHarness(); h.connectAll(); const key = h.expire('work');
  h.context.connectionStatus();
  assert.ok(JSON.parse(h.props[key]).expiresAt > Date.now() / 1000);
  assert.equal(JSON.parse(h.props[key]).refresh_token, 'refresh:work@example.com');
  assert.ok(h.calls.some(c => c.options.payload?.grant_type === 'refresh_token'));
});
test('failed refresh aborts sync before calendar writes and reports account key safely', () => {
  const h = oauthHarness(); h.connectAll(); h.expire('work'); h.refreshFails = true;
  assert.throws(() => h.context.syncCalendars(), /Account "work"/);
  assert.equal(h.calls.some(c => c.url.includes('/calendar/v3/')), false);
  assert.ok(!h.logs.join('').includes('TOP_SECRET'));
});
test('full sync routes all REST reads and writes by account without sharing', () => {
  const h = oauthHarness(); h.connectAll();
  h.db['personal@example.com'].push(h.event('p')); h.db['work@example.com'].push(h.event('w'));
  const preview = h.context.previewSync(); assert.equal(preview.planned.insert, 2); assert.equal(h.db['personal@example.com'].length, 1);
  const run = h.context.syncCalendars(); assert.equal(run.applied, 2);
  assert.equal(h.db['personal@example.com'][1].summary, 'EVENT_SECRET'); assert.equal(h.db['work@example.com'][1].summary, 'Busy');
  assert.equal(h.context.syncCalendars().applied, 0);
  h.db['work@example.com'][0].summary = 'DETAIL_UPDATE'; assert.equal(h.context.syncCalendars().planned.update, 1);
  h.db['work@example.com'].shift(); assert.equal(h.context.syncCalendars().planned.delete, 1);
  for (const call of h.calls.filter(c => c.url.includes('/calendar/v3/'))) {
    assert.equal(call.options.followRedirects, false);
    if (call.options.method !== 'get') assert.equal(new URL(call.url).searchParams.get('sendUpdates'), 'none');
  }
  assert.ok(!h.logs.join('').includes('EVENT_SECRET')); assert.ok(!h.logs.join('').includes('DETAIL_UPDATE'));
});
test('retired accounts retain routes for cleanup even after removing account definition', () => {
  const h = oauthHarness(); h.connectAll(); h.db['personal@example.com'].push(h.event('p')); h.context.syncCalendars();
  h.context.SYNC_CONFIG.calendars.pop(); h.context.SYNC_CONFIG.accounts.pop();
  h.failWork = true; assert.throws(() => h.context.syncCalendars(), /account "work"/);
  assert.ok(JSON.parse(h.props.busySyncCalendarRoutes)['work@example.com']);
  h.failWork = false; h.context.syncCalendars(); assert.equal(h.db['work@example.com'].length, 0);
  h.props.OAUTH_ACCOUNT_KEY = 'work'; h.context.disconnectAccount(); assert.equal(h.props['busySyncAccount:work'], undefined);
});
test('disconnect refuses to strand active calendars or pending retirement', () => {
  const h = oauthHarness(); h.connectAll(); h.context.syncCalendars(); h.props.OAUTH_ACCOUNT_KEY = 'work';
  assert.throws(() => h.context.disconnectAccount(), /cleanup before disconnecting/);
  h.context.SYNC_CONFIG.calendars.pop(); assert.throws(() => h.context.disconnectAccount(), /cleanup before disconnecting/);
});
test('HTTP errors expose status and account but never response bodies', () => {
  const h = oauthHarness(); h.connectAll();
  for (const code of [401, 403, 404, 429, 500]) {
    h.httpFailure = code; assert.throws(() => h.context.previewSync(), new RegExp('HTTP ' + code));
    assert.ok(!h.logs.join('').includes('TOP_SECRET'));
  }
});
test('changing OAuth client requires reconnect instead of reusing old grants', () => {
  const h = oauthHarness(); h.connectAll(); h.props.GOOGLE_OAUTH_CLIENT_ID = 'changed-client';
  assert.throws(() => h.context.previewSync(), /Connect account/);
});
test('legacy block ownership survives OAuth migration', () => {
  const h = oauthHarness(); h.connectAll(); h.props.busySyncOwner = 'legacy-owner';
  h.props.busySyncCalendars = JSON.stringify(['personal@example.com', 'work@example.com']);
  h.db['work@example.com'].push(h.event('w')); h.context.syncCalendars();
  assert.equal(h.props.busySyncOwner, 'legacy-owner');
  assert.equal(h.db['personal@example.com'][0].extendedProperties.private.busySyncOwner, 'legacy-owner');
  assert.equal(h.context.syncCalendars().applied, 0);
});

test('calendar connection check is read-only and reports each account role', () => {
  const h = oauthHarness(); h.connectAll();
  const result = h.context.checkCalendarConnections();
  assert.equal(result.length, 2); assert.ok(result.every(r => r.ok && r.accessRole === 'owner'));
  assert.ok(h.calls.filter(c => c.url.includes('/calendar/v3/')).every(c => c.options.method === 'get'));
  h.httpFailure = 404;
  assert.ok(h.context.checkCalendarConnections().every(r => !r.ok));
});
test('OAuth cleanup removes owned copies while preserving source events', () => {
  const h = oauthHarness(); h.connectAll(); h.db['work@example.com'].push(h.event('original'));
  h.context.syncCalendars(); h.context.cleanupAllBlocks();
  assert.equal(h.db['personal@example.com'].length, 0); assert.equal(h.db['work@example.com'][0].id, 'original');
  assert.deepEqual(JSON.parse(h.props.busySyncCalendarRoutes), {});
});
test('invalid account mappings fail before any Calendar request', () => {
  const h = oauthHarness(); h.connectAll(); h.context.SYNC_CONFIG.calendars[1].account = 'unknown';
  assert.throws(() => h.context.previewSync());
  assert.ok(!h.calls.some(c => c.url.includes('/calendar/v3/')));
});
test('failed last-calendar read preserves every existing copy', () => {
  const h = oauthHarness(); h.connectAll(); h.db['work@example.com'].push(h.event('original'));
  h.context.syncCalendars(); const before = clone(h.db['personal@example.com']);
  h.db['work@example.com'] = []; h.failWork = true;
  assert.throws(() => h.context.syncCalendars(), /HTTP 503/);
  assert.deepEqual(h.db['personal@example.com'], before);
});


test('adding OAuth accounts, changing hub, retirement and wider grants cannot propagate copies', () => {
  const h = oauthHarness(), c = h.context.SYNC_CONFIG;
  h.connectAll();
  for (const calendar of c.calendars) h.db[calendar.id].push(h.event('original-' + calendar.account));
  h.context.syncCalendars();
  // Add accounts after copies already exist, including an account with a wider grant.
  h.tokenScope += ' https://www.googleapis.com/auth/calendar.readonly';
  for (const key of ['clientone', 'clienttwo']) {
    const email = key + '@example.com';
    c.accounts.push({ key, email });
    c.calendars.push({ id: email, account: key });
    h.db[email] = [h.event('original-' + key)];
    assert.match(h.connect(key), /Account connected/);
  }
  const originals = Object.fromEntries(c.calendars.map(cal => [cal.id, clone(h.db[cal.id].find(e => e.id.startsWith('original-')))]));
  function checkStable() {
    for (let i = 0; i < 3; i++) assert.equal(h.context.syncCalendars().applied, 0);
    const sources = c.calendars.filter(cal => h.db[cal.id].some(e => e.id.startsWith('original-')));
    for (const cal of c.calendars) {
      const copies = h.db[cal.id].filter(e => e.extendedProperties);
      assert.equal(copies.length, sources.filter(source => source.id !== cal.id).length);
      for (const copy of copies) {
        assert.equal(copy.summary, cal.id === c.hubCalendarId ? 'EVENT_SECRET' : 'Busy');
        if (cal.id !== c.hubCalendarId) assert.equal(copy.description, undefined);
      }
      const original = h.db[cal.id].find(e => e.id.startsWith('original-'));
      if (original) assert.deepEqual(original, originals[cal.id]);
    }
  }
  h.context.syncCalendars();
  checkStable();
  for (const hub of ['clientone@example.com', null, 'personal@example.com']) {
    c.hubCalendarId = hub;
    h.context.syncCalendars();
    checkStable();
  }
  const retired = c.calendars.pop();
  h.context.syncCalendars();
  assert.deepEqual(h.db[retired.id], [originals[retired.id]]);
  checkStable();
  c.calendars.push(retired);
  h.context.syncCalendars();
  checkStable();
  h.db['work@example.com'] = h.db['work@example.com'].filter(e => !e.id.startsWith('original-'));
  h.context.syncCalendars();
  checkStable();
});
