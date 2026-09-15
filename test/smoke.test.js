const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// Exercise the live runner through its reschedule assertion. Stop before the
// remaining fixture scenarios, which are covered by the sync adapter tests.
function rescheduleProbe(wrongEnd = false) {
  let calendar = 0, source, synced = false, dirty = false, owner = null;
  const requested = [];
  const finished = new Error('Reached cancellation phase');
  const normalize = body => ({ ...body, start: { dateTime: new Date(Math.floor(Date.parse(body.start.dateTime) / 1000) * 1000).toISOString() }, end: { dateTime: new Date(Math.floor(Date.parse(body.end.dateTime) / 1000) * 1000).toISOString() } });
  const context = {
    Date: class extends Date { static now() { return Date.parse('2026-09-15T16:18:23.087Z'); } },
    SYNC_CONFIG: { calendars: [] },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => owner, setProperty: () => {} }) },
    Utilities: { getUuid: () => 'fixture' },
    previewSync() { owner = 'owner'; },
    syncCalendars() { const applied = !synced || dirty ? 2 : 0; synced = true; dirty = false; return { applied }; },
    Calendar: {
      Calendars: { insert: () => ({ id: String(++calendar) }) },
      Events: {
        insert(body) { requested.push(body); source = normalize({ ...body, id: 'original' }); return source; },
        patch(body) { requested.push(body); source = normalize({ ...source, ...body }); dirty = true; return source; },
        list(id) {
          if (!synced) return { items: [] };
          const end = wrongEnd && requested.length === 2 && id === '3' ? { dateTime: '2026-09-17T23:00:00Z' } : source.end;
          return { items: [{ summary: 'Busy', visibility: 'private', start: source.start, end }] };
        },
        remove() { throw finished; }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('test/live/SmokeTest.gs', 'utf8'), context);
  context.cleanupSmokeFixtures = () => {};
  return { run: () => context.liveSmokeTest(), requested, finished };
}

test('live reschedule test tolerates provider precision normalization', () => {
  const probe = rescheduleProbe();
  assert.throws(probe.run, error => error === probe.finished);
  for (const request of probe.requested) {
    assert.equal(Date.parse(request.start.dateTime) % 60000, 0);
    assert.equal(Date.parse(request.end.dateTime) % 60000, 0);
  }
});
test('live reschedule test catches a wrong end time on the second destination', () => {
  const probe = rescheduleProbe(true);
  assert.throws(probe.run, /reschedule failed on destination 2: expected .* got /);
});
