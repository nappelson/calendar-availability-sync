/** Apps Script entry points. No event content is logged. */
function previewSync() { return runBusySync_(true, false); }
function syncCalendars() { return runBusySync_(false, false); }
function previewCleanup() { return runBusySync_(true, true); }
// Removes ALL blocks made by this installation, including historical copies.
function cleanupAllBlocks() { return runBusySync_(false, true); }
function syncStatus() {
  var value = PropertiesService.getScriptProperties().getProperty('busySyncStatus');
  console.log(value || 'No run recorded.');
  return value ? JSON.parse(value) : null;
}
function installSync() {
  BusySync.validate(SYNC_CONFIG);
  if (SYNC_CONFIG.calendars.length < 2) throw new Error('Configure at least two calendars before scheduling.');
  var preview = previewSync();
  if (!preview.ok) throw new Error('Preview did not complete. Retry installing after the active run finishes.');
  stopSync();
  ScriptApp.newTrigger('syncCalendars').timeBased().everyMinutes(5).create();
}
function stopSync() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncCalendars') ScriptApp.deleteTrigger(t);
  });
}
// Return only fixed diagnostic text; never expose the provider's raw message.
function safeSyncError_(error) {
  if (error && error.busySyncSafe) return error.message;
  var message = String(error && error.message || '');
  if (message === 'Write access required.') return 'Calendar is readable but lacks write access. Share it with the account running this script using Make changes to events.';
  if (/rate.?limit|quota|too many|too much|invoked too many/i.test(message)) return 'Google quota or rate limit reached. Wait and retry.';
  if (/not found|404/i.test(message)) return 'Calendar or event not found, or not visible to this account. Check the Calendar ID and sharing with the account running this script.';
  if (/forbidden|permission|access denied|insufficient|403/i.test(message)) return 'Google denied access. Check calendar sharing, organization restrictions, and script authorization.';
  if (/unauthorized|invalid credentials|login required|401/i.test(message)) return 'Google authorization is missing or expired. Run the script manually and authorize it again.';
  if (/timeout|timed out|backend error|internal error|service unavailable/i.test(message)) return 'Google service request failed temporarily. Retry the run.';
  if (message === 'Time budget exceeded.') return 'Calendar reads or planning exceeded the time budget before writes could finish. Retry; if this repeats during reads, reduce daysAhead or the number of calendars.';
  if (message === 'Calendar exceeds safety size limit.') return 'Calendar query exceeded the 20,000-event safety limit.';
  if (message.indexOf('Change limit exceeded.') === 0) return 'Change limit exceeded. Inspect planned counts and adjust maxChangesPerRun deliberately.';
  return 'Run stopped. Check configuration and Google service availability. Existing successful writes will reconcile on the next run.';
}
function runBusySync_(dryRun, cleanup) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    if (cleanup) throw new Error('Cleanup could not acquire the lock. Scheduling is unchanged; retry after the active run finishes.');
    return { skipped: 'Another run is active.' };
  }
  var props = PropertiesService.getScriptProperties();
  var started = Date.now();
  var result = { mode: cleanup ? 'cleanup' : 'sync', dryRun: dryRun, stage: 'configuration', startedAt: new Date(started).toISOString(), lastSuccessfulSyncAt: null, planned: { insert: 0, update: 0, delete: 0 }, applied: 0 };
  try {
    var previous = JSON.parse(props.getProperty('busySyncStatus') || '{}');
    result.lastSuccessfulSyncAt = previous.lastSuccessfulSyncAt || null;
    BusySync.validate(SYNC_CONFIG);
    if (!cleanup && !SYNC_CONFIG.calendars.length) throw new Error('Empty configuration. Use cleanupAllBlocks for intentional removal of everything.');
    var owner = props.getProperty('busySyncOwner');
    var registry = JSON.parse(props.getProperty('busySyncCalendars') || '[]');
    if (!owner && registry.length) throw new Error('Missing installation identity. Restore script properties.');
    if (!owner) { owner = Utilities.getUuid(); props.setProperty('busySyncOwner', owner); }
    var active = cleanup ? [] : SYNC_CONFIG.calendars.map(function (c) { return c.id; });
    var targets = Array.from(new Set(registry.concat(SYNC_CONFIG.calendars.map(function (c) { return c.id; }))));
    result.stage = 'account access';
    var access = createCalendarAccess_(targets, props), eventsApi = access.events;
    var snapshots = {};
    function guard() { if (Date.now() - started > 240000) throw new Error('Time budget exceeded.'); }
    function listAll(id, options) {
      var items = [], pageToken;
      do {
        guard();
        var page = eventsApi.list(id, Object.assign({}, options, pageToken ? { pageToken: pageToken } : {}));
        result.accessRole = ['owner', 'writer', 'writerWithoutPrivateAccess', 'reader', 'freeBusyReader', 'none'].indexOf(page.accessRole) >= 0 ? page.accessRole : 'unknown';
        if (['owner', 'writer', 'writerWithoutPrivateAccess'].indexOf(page.accessRole) < 0) {
          if (access.routes) throw oauthError_('Account "' + access.routes[id].key + '" lacks write access to its configured calendar. Check the calendar’s account mapping and permissions.');
          throw new Error('Write access required.');
        }
        items = items.concat(page.items || []);
        if (items.length > 20000) throw new Error('Calendar exceeds safety size limit.');
        pageToken = page.nextPageToken;
      } while (pageToken);
      return items;
    }
    // All reads (including every page) must complete before any calendar mutation.
    targets.forEach(function (id, index) {
      result.stage = 'read calendar ' + (index + 1) + ' of ' + targets.length;
      delete result.accessRole;
      result.calendarConfigIndex = SYNC_CONFIG.calendars.findIndex(function (c) { return c.id === id; }) + 1;
      result.retiredCalendar = active.indexOf(id) < 0;
      var events = active.indexOf(id) < 0 ? [] : listAll(id, {
        timeMin: new Date(started).toISOString(),
        timeMax: new Date(started + SYNC_CONFIG.daysAhead * 86400000).toISOString(),
        singleEvents: true, showDeleted: false, maxResults: 2500
      });
      // A single constraint avoids ambiguous AND/OR semantics for repeated
      // private-property filters. Verify both ownership fields locally.
      var managed = listAll(id, { privateExtendedProperty: ['busySyncOwner=' + owner], showDeleted: false, maxResults: 2500 })
        .filter(function (event) { return BusySync.managed(event, owner); });
      snapshots[id] = { events: events, managed: managed };
    });
    result.stage = 'plan';
    var config = Object.assign({}, SYNC_CONFIG, { calendars: cleanup ? [] : SYNC_CONFIG.calendars, hubCalendarId: cleanup ? null : SYNC_CONFIG.hubCalendarId });
    var actions = BusySync.plan(config, snapshots, owner, function (s) {
      return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8).map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
    });
    actions.forEach(function (a) { result.planned[a.type]++; });
    result.stage = 'change limit';
    if (actions.length > SYNC_CONFIG.maxChangesPerRun) throw new Error('Change limit exceeded. Inspect preview counts and raise maxChangesPerRun deliberately.');
    if (!dryRun) {
      // Only stop scheduling after acquiring the lock and validating the plan.
      if (cleanup) stopSync();
      // Keep all destinations recoverable even if writes partially fail.
      props.setProperty('busySyncCalendars', JSON.stringify(targets));
      if (access.routes) props.setProperty('busySyncCalendarRoutes', JSON.stringify(access.routes));
      function pauseForNextRun() {
        result.stage = 'partial';
        result.ok = true;
        result.complete = false;
        result.remaining = actions.length - result.applied;
        return result;
      }
      for (var actionIndex = 0; actionIndex < actions.length; actionIndex++) {
        // Leave time to finish the current request and persist status. Each
        // subsequent run reads fresh snapshots, so no stale plan is replayed.
        if (Date.now() - started >= 210000) return pauseForNextRun();
        var a = actions[actionIndex];
        result.stage = a.type + ' operation ' + (result.applied + 1) + ' of ' + actions.length;
        if (a.type === 'insert') {
          // Each attempted insert has its own ID. Do not retry ambiguous errors;
          // the next complete read finds committed inserts using private metadata.
          var resource = Object.assign({ id: Utilities.getUuid().replace(/-/g, '') }, a.body);
          eventsApi.insert(resource, a.calendar, { sendUpdates: 'none' });
        } else {
          var current = eventsApi.get(a.calendar, a.id);
          if (!BusySync.managed(current, owner) || (current.attendees || []).length || (current.organizer && !current.organizer.self)) throw new Error('Changed block requires manual inspection.');
          if (Date.now() - started >= 210000) return pauseForNextRun();
          if (a.type === 'delete') eventsApi.remove(a.calendar, a.id, { sendUpdates: 'none' });
          else eventsApi.update(a.body, a.calendar, a.id, { sendUpdates: 'none' });
        }
        result.applied++;
      }
      props.setProperty('busySyncCalendars', JSON.stringify(active));
      if (access.routes) {
        var remainingRoutes = {};
        active.forEach(function (id) { remainingRoutes[id] = access.routes[id]; });
        props.setProperty('busySyncCalendarRoutes', JSON.stringify(remainingRoutes));
      }
      if (!cleanup) result.lastSuccessfulSyncAt = new Date().toISOString();
    }
    result.stage = 'complete';
    result.ok = true;
    result.complete = true;
    return result;
  } catch (error) {
    result.ok = false;
    // API errors can contain calendar IDs or event content; don't persist them.
    result.error = safeSyncError_(error);
    throw new Error(result.error);
  } finally {
    result.finishedAt = new Date().toISOString();
    props.setProperty('busySyncStatus', JSON.stringify(result));
    console.log(JSON.stringify(result));
    lock.releaseLock();
  }
}
