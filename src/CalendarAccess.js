/** Calendar transport. Production uses a separate OAuth grant per account. */
function createCalendarAccess_(targets, props) {
  if (SYNC_CONFIG.authMode !== 'oauth') return { events: Calendar.Events, routes: null };
  var saved = JSON.parse(props.getProperty('busySyncCalendarRoutes') || '{}');
  var routes = {}, services = Object.create(null);
  targets.forEach(function (id) {
    var calendar = SYNC_CONFIG.calendars.filter(function (c) { return c.id === id; })[0];
    var account = calendar ? accountDefinition_(calendar.account) : saved[id];
    if (!account) throw oauthError_('A retired calendar has no saved OAuth route. Temporarily restore its Config entry with an account key, sync, then remove it again.');
    routes[id] = { key: account.key, email: account.email.toLowerCase() };
    if (!services[account.key]) services[account.key] = connectedService_(account);
  });
  function request(method, calendar, eventId, params, body) {
    var route = routes[calendar];
    if (!route) throw oauthError_('Calendar has no authorized account route.');
    var service = services[route.key];
    var url = 'https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendar) + '/events' + (eventId ? '/' + encodeURIComponent(eventId) : '');
    var query = [];
    Object.keys(params || {}).forEach(function (key) {
      var values = Array.isArray(params[key]) ? params[key] : [params[key]];
      values.forEach(function (value) { query.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value))); });
    });
    if (query.length) url += '?' + query.join('&');
    var options = { method: method, headers: { Authorization: 'Bearer ' + service.getAccessToken() }, muteHttpExceptions: true, followRedirects: false };
    if (body) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
    // No automatic mutation retries: timeouts may occur after Google commits.
    var response;
    try { response = UrlFetchApp.fetch(url, options); }
    catch (error) { throw oauthError_('Google request failed for account "' + route.key + '". Retry sync; committed writes will be reconciled.'); }
    var code = response.getResponseCode();
    if (code < 200 || code >= 300) {
      var reason = code === 401 ? 'Reconnect using showAuthorizationLinks.' : code === 403 ? 'Check granted permissions, Workspace app restrictions, and quota.' : code === 404 ? 'Check Calendar ID and that this account owns or can access it.' : code === 429 || code >= 500 ? 'Temporary quota or service failure; retry later.' : 'Request rejected; check configuration.';
      throw oauthError_('Calendar API HTTP ' + code + ' for account "' + route.key + '". ' + reason);
    }
    var text = response.getContentText();
    if (!text) return {};
    try { return JSON.parse(text); } catch (error) { throw oauthError_('Google returned an invalid response. Retry the sync.'); }
  }
  return {
    routes: routes,
    events: {
      list: function (id, params) { return request('get', id, null, params); },
      get: function (id, eventId) { return request('get', id, eventId); },
      insert: function (body, id, params) { return request('post', id, null, params, body); },
      update: function (body, id, eventId, params) { return request('put', id, eventId, params, body); },
      remove: function (id, eventId, params) { return request('delete', id, eventId, params); }
    }
  };
}
