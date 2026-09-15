/** Run ONLY in a separate, disposable Apps Script project with the src files. */
function liveSmokeTest() {
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('busySyncCalendars') || p.getProperty('busySyncOwner')) throw new Error('Use a fresh test project. Clean up previous fixtures first.');
  if (SYNC_CONFIG.calendars.length) throw new Error('Keep Config calendars empty in this test project.');
  var ids = [], run = Utilities.getUuid(), originalConfig = SYNC_CONFIG;
  function check(value, message) { if (!value) throw new Error('Smoke test: ' + message); }
  function blocks(id) {
    return (Calendar.Events.list(id, { privateExtendedProperty: ['busySyncOwner=' + p.getProperty('busySyncOwner')], maxResults: 2500 }).items || []);
  }
  function sameInstant(actual, expected) { return Date.parse(actual) === Date.parse(expected); }
  try {
    for (var i = 0; i < 3; i++) {
      var cal = Calendar.Calendars.insert({ summary: 'BusySync disposable test ' + run + ' ' + i, timeZone: 'America/Toronto' });
      ids.push(cal.id);
      p.setProperty('busySyncTestFixtures', JSON.stringify(ids));
    }
    SYNC_CONFIG = Object.assign({}, originalConfig, { authMode: 'shared', hubCalendarId: null, calendars: ids.map(function (id) { return { id: id }; }), maxChangesPerRun: 100 });
    // Calendar may normalize sub-second precision. Use whole-minute fixtures
    // and compare copies with the source resource returned by Google.
    var start = new Date(Math.floor(Date.now() / 60000) * 60000 + 86400000 * 2).toISOString();
    var end = new Date(Date.parse(start) + 3600000).toISOString();
    var original = Calendar.Events.insert({ summary: 'Fixture detail must not copy', description: 'Fixture secret', start: { dateTime: start }, end: { dateTime: end } }, ids[0]);
    previewSync(); check(blocks(ids[1]).length === 0, 'preview wrote an event');
    syncCalendars();
    check(blocks(ids[1]).length === 1 && blocks(ids[2]).length === 1, 'all-way copies missing');
    var copy = blocks(ids[1])[0];
    check(copy.summary === 'Busy' && !copy.description && !copy.attendees && copy.visibility === 'private', 'privacy fields wrong');
    check(syncCalendars().applied === 0, 'second run should be idempotent');
    start = new Date(Date.parse(start) + 7200000).toISOString(); end = new Date(Date.parse(end) + 7200000).toISOString();
    var updated = Calendar.Events.patch({ start: { dateTime: start }, end: { dateTime: end } }, ids[0], original.id);
    syncCalendars();
    [ids[1], ids[2]].forEach(function (id, index) {
      var copies = blocks(id);
      check(copies.length === 1, 'reschedule copy count on destination ' + (index + 1));
      copy = copies[0];
      check(sameInstant(copy.start.dateTime, updated.start.dateTime) && sameInstant(copy.end.dateTime, updated.end.dateTime),
        'reschedule failed on destination ' + (index + 1) + ': expected ' + updated.start.dateTime + ' to ' + updated.end.dateTime + ', got ' + copy.start.dateTime + ' to ' + copy.end.dateTime);
    });
    Calendar.Events.remove(ids[0], original.id);
    syncCalendars(); check(blocks(ids[1]).length === 0, 'cancellation failed');
    var series = Calendar.Events.insert({ summary: 'Recurring fixture', start: { dateTime: start, timeZone: 'America/Toronto' }, end: { dateTime: end, timeZone: 'America/Toronto' }, recurrence: ['RRULE:FREQ=DAILY;COUNT=3'] }, ids[0]);
    syncCalendars(); check(blocks(ids[1]).length === 3, 'recurrence expansion failed');
    SYNC_CONFIG.hubCalendarId = ids[1];
    syncCalendars();
    check(blocks(ids[1]).every(function (e) { return e.summary === 'Recurring fixture'; }), 'hub titles not copied');
    check(blocks(ids[2]).every(function (e) { return e.summary === 'Busy' && !e.description && !e.location; }), 'details escaped hub');
    check(syncCalendars().applied === 0, 'hub sync not idempotent');
    Calendar.Events.patch({ description: 'Updated fixture details', location: 'Fixture room' }, ids[0], series.id);
    syncCalendars();
    check(blocks(ids[1]).every(function (e) { return e.description.indexOf('Updated fixture details') >= 0 && e.location === 'Fixture room'; }), 'hub detail update failed');
    SYNC_CONFIG.hubCalendarId = null;
    syncCalendars();
    check(blocks(ids[1]).every(function (e) { return e.summary === 'Busy' && !e.description && !e.location; }), 'disabling hub did not remove details');
    var instances = Calendar.Events.instances(ids[0], series.id).items;
    Calendar.Events.remove(ids[0], instances[1].id);
    syncCalendars(); check(blocks(ids[1]).length === 2, 'recurring cancellation failed');
    SYNC_CONFIG.calendars.pop(); syncCalendars(); check(blocks(ids[2]).length === 0, 'retirement cleanup failed');
    SYNC_CONFIG.calendars.push({ id: ids[2] }); syncCalendars(); check(blocks(ids[2]).length === 2, 'calendar re-add failed');
    cleanupAllBlocks(); check(blocks(ids[1]).length === 0, 'cleanup failed');
    check(Calendar.Events.get(ids[0], series.id).status !== 'cancelled', 'original modified');
    console.log('LIVE SMOKE TEST PASSED');
  } finally {
    SYNC_CONFIG = originalConfig;
    cleanupSmokeFixtures();
  }
}
function cleanupSmokeFixtures() {
  var p = PropertiesService.getScriptProperties();
  var ids = JSON.parse(p.getProperty('busySyncTestFixtures') || '[]');
  var failed = [];
  ids.forEach(function (id) {
    try {
      var cal = Calendar.Calendars.get(id);
      if (cal.summary.indexOf('BusySync disposable test ') !== 0) throw new Error('Fixture name changed');
      Calendar.Calendars.remove(id);
    } catch (error) { failed.push(id); }
  });
  p.setProperty('busySyncTestFixtures', JSON.stringify(failed));
  if (failed.length) throw new Error('Fixture cleanup incomplete. Inspect test calendars and retry cleanupSmokeFixtures.');
  p.deleteProperty('busySyncOwner');
  p.deleteProperty('busySyncCalendars');
}
