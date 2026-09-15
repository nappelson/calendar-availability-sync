/* Pure reconciliation engine, shared by Apps Script and Node tests. */
var BusySync = (function () {
  var APP = 'personal-busy-sync-v1';
  function properties(e) { return (e.extendedProperties || {}).private || {}; }
  function managed(e, owner) { var p = properties(e); return p.busySyncApp === APP && p.busySyncOwner === owner; }
  function validate(c) {
    if (!c || !Array.isArray(c.calendars)) throw new Error('Configure calendars first.');
    if (c.authMode != null && ['shared', 'oauth'].indexOf(c.authMode) < 0) throw new Error('Invalid authMode.');
    if (c.authMode === 'oauth') {
      if (!Array.isArray(c.accounts)) throw new Error('Configure OAuth accounts.');
      var keys = c.accounts.map(function (a) { return a.key; });
      if (keys.some(function (k) { return typeof k !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(k); }) || new Set(keys).size !== keys.length) throw new Error('Account keys must be unique lowercase identifiers.');
      if (c.accounts.some(function (a) { return typeof a.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email); })) throw new Error('Each account requires an email address.');
      if (c.calendars.some(function (calendar) { return keys.indexOf(calendar.account) < 0; })) throw new Error('Each calendar must reference a configured account key.');
    }
    var ids = c.calendars.map(function (x) { return x.id; });
    if (ids.some(function (id) { return typeof id !== 'string' || !id.trim() || id !== id.trim() || id === 'primary'; }) || new Set(ids).size !== ids.length) throw new Error('Calendar IDs must be explicit, unique, and nonempty.');
    if (c.hubCalendarId != null && (typeof c.hubCalendarId !== 'string' || ids.indexOf(c.hubCalendarId) < 0)) throw new Error('hubCalendarId must identify a configured calendar, or be null.');
    if (!Number.isInteger(c.daysAhead) || c.daysAhead < 1 || c.daysAhead > 366) throw new Error('daysAhead must be 1–366.');
    if (!Number.isInteger(c.maxChangesPerRun) || c.maxChangesPerRun < 1) throw new Error('Invalid change limit.');
    ['includeAllDay', 'includeUnanswered', 'includeTentative'].forEach(function (k) { if (typeof c[k] !== 'boolean') throw new Error('Invalid policy: ' + k); });
  }
  function eligible(e, c) {
    if (properties(e).busySyncApp === APP || e.status === 'cancelled' || e.transparency === 'transparent' || ['workingLocation', 'birthday'].indexOf(e.eventType) >= 0) return false;
    if (!e.start || !e.end) throw new Error('Source event lacks dates; refusing reconciliation.');
    if (e.start.date && !c.includeAllDay) return false;
    var self = (e.attendees || []).filter(function (a) { return a.self; })[0];
    if (self && (self.responseStatus === 'declined' || (self.responseStatus === 'needsAction' && !c.includeUnanswered) || (self.responseStatus === 'tentative' && !c.includeTentative))) return false;
    return true;
  }
  function when(t) { return t.date || new Date(t.dateTime).toISOString(); }
  // Copies of the same invitation can disagree after a reschedule. Only
  // suppress an identical interval; otherwise protect both versions' times.
  function identity(e) { return e.iCalUID ? JSON.stringify([e.iCalUID, e.originalStartTime ? when(e.originalStartTime) : 'single', when(e.start), when(e.end)]) : null; }
  function time(t) { return t.date ? { date: t.date } : { dateTime: new Date(t.dateTime).toISOString() }; }
  function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function description(e, sourceLabel) {
    var links = [];
    function add(label, url) {
      if (typeof url === 'string' && /^https?:\/\//i.test(url) && !links.some(function (x) { return x.url === url; })) links.push({ label: label, url: url });
    }
    add('Original event', e.htmlLink);
    add('Join meeting', e.hangoutLink);
    ((e.conferenceData || {}).entryPoints || []).forEach(function (point) { if (point.entryPointType === 'video') add('Join meeting', point.uri); });
    var parts = ['Source calendar: ' + escapeHtml(sourceLabel)];
    if (e.description) parts.push(e.description);
    links.forEach(function (link) { parts.push(escapeHtml(link.label + ': ' + link.url)); });
    return parts.join('<br><br>');
  }
  function body(e, owner, key, detailed, sourceLabel) {
    var copy = { summary: detailed ? (e.summary || '(Untitled event)') : 'Busy', start: time(e.start), end: time(e.end), status: 'confirmed', transparency: 'opaque', visibility: 'private', reminders: { useDefault: false, overrides: [] }, extendedProperties: { private: { busySyncApp: APP, busySyncOwner: owner, busySyncKey: key } } };
    if (detailed) {
      copy.description = description(e, sourceLabel);
      copy.location = e.location || '';
    }
    return copy;
  }
  function equivalent(e, b) {
    return e.summary === b.summary && when(e.start) === when(b.start) && when(e.end) === when(b.end) && (e.transparency || 'opaque') === 'opaque' && e.visibility === 'private' && e.status === 'confirmed' && e.reminders && e.reminders.useDefault === false && !(e.reminders.overrides || []).length && (e.description || '') === (b.description || '') && (e.location || '') === (b.location || '') && !(e.attendees || []).length && !e.conferenceData;
  }
  function plan(c, snapshots, owner, hash) {
    validate(c);
    var active = c.calendars.map(function (x) { return x.id; });
    var originals = {};
    active.forEach(function (id) { if (!snapshots[id]) throw new Error('Missing calendar snapshot.'); originals[id] = snapshots[id].events.filter(function (e) { return eligible(e, c); }); });
    var actions = [];
    Object.keys(snapshots).forEach(function (dest) {
      var desired = {};
      if (active.indexOf(dest) >= 0) {
        var seen = new Set(originals[dest].map(identity).filter(Boolean));
        active.forEach(function (source) {
          if (source === dest) return;
          var sourceCalendar = c.calendars.filter(function (calendar) { return calendar.id === source; })[0];
          var sourceLabel = typeof sourceCalendar.label === 'string' && sourceCalendar.label.trim() ? sourceCalendar.label.trim() : source;
          originals[source].forEach(function (e) {
            var uid = identity(e);
            if (uid && seen.has(uid)) return;
            if (uid) seen.add(uid);
            var key = hash(JSON.stringify([source, e.id]));
            desired[key] = body(e, owner, key, dest === c.hubCalendarId, sourceLabel);
          });
        });
      }
      var existing = {};
      snapshots[dest].managed.forEach(function (e) {
        if (!managed(e, owner)) throw new Error('Ownership mismatch.');
        var k = properties(e).busySyncKey;
        if (!desired[k] || existing[k]) actions.push({ type: 'delete', calendar: dest, id: e.id });
        else existing[k] = e;
      });
      Object.keys(desired).forEach(function (k) {
        var e = existing[k], b = desired[k];
        if (!e) actions.push({ type: 'insert', calendar: dest, body: b });
        else if (!equivalent(e, b)) actions.push({ type: 'update', calendar: dest, id: e.id, body: b });
      });
    });
    // Protect availability: create/update before deleting obsolete blocks.
    return actions.sort(function (a, b) { return (a.type === 'delete') - (b.type === 'delete'); });
  }
  return { APP: APP, managed: managed, validate: validate, plan: plan };
})();
if (typeof module !== 'undefined') module.exports = BusySync;
