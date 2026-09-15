/** Separate Google grants, stored in this private project's Script Properties. */
var CALENDAR_SCOPE_ = 'https://www.googleapis.com/auth/calendar.events';
function oauthError_(message) {
  var error = new Error(message);
  error.busySyncSafe = true;
  return error;
}
function oauthSettings_() {
  var props = PropertiesService.getScriptProperties();
  var clientId = props.getProperty('GOOGLE_OAUTH_CLIENT_ID');
  var secret = props.getProperty('GOOGLE_OAUTH_CLIENT_SECRET');
  if (!clientId || !secret) throw oauthError_('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in Script Properties.');
  return { props: props, clientId: clientId, secret: secret };
}
function accountDefinition_(key) {
  return (SYNC_CONFIG.accounts || []).filter(function (a) { return a.key === key; })[0];
}
function oauthService_(name) {
  var settings = oauthSettings_();
  return OAuth2.createService(name)
    .setAuthorizationBaseUrl('https://accounts.google.com/o/oauth2/v2/auth')
    .setTokenUrl('https://oauth2.googleapis.com/token')
    .setClientId(settings.clientId).setClientSecret(settings.secret)
    .setCallbackFunction('googleAccountCallback')
    .setPropertyStore(settings.props)
    .setLock(LockService.getScriptLock())
    .setScope('openid email ' + CALENDAR_SCOPE_)
    .setParam('access_type', 'offline')
    .setParam('prompt', 'consent select_account');
}
function oauthRecord_(key) {
  return JSON.parse(PropertiesService.getScriptProperties().getProperty('busySyncAccount:' + key) || 'null');
}
function connectedService_(account) {
  var settings = oauthSettings_(), record = oauthRecord_(account.key);
  if (!record || record.email !== account.email.toLowerCase() || record.clientId !== settings.clientId) throw oauthError_('Connect account "' + account.key + '" using showAuthorizationLinks.');
  var service = oauthService_(record.serviceName);
  try {
    if (!service.hasAccess()) throw new Error('Unavailable token');
  } catch (error) {
    throw oauthError_('Account "' + account.key + '" could not obtain access. Retry; if it persists, reconnect using showAuthorizationLinks.');
  }
  return service;
}
function withOAuthLock_(action) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) throw oauthError_('A sync or account operation is active. Retry when it finishes.');
  try { return action(); } finally { lock.releaseLock(); }
}
// Run once after setting client credentials. Does not reveal the secret.
function oauthSetupInfo() {
  var settings = oauthSettings_();
  var result = { redirectUri: OAuth2.getRedirectUri(), clientId: settings.clientId, scopes: ['openid', 'email', CALENDAR_SCOPE_] };
  console.log(JSON.stringify(result));
  return result;
}
// Optionally set OAUTH_ACCOUNT_KEY in Script Properties to show only one link.
function showAuthorizationLinks() {
  return withOAuthLock_(function () {
    BusySync.validate(SYNC_CONFIG);
    if (SYNC_CONFIG.authMode !== 'oauth') throw oauthError_('Set authMode to oauth first.');
    var settings = oauthSettings_(), selected = settings.props.getProperty('OAUTH_ACCOUNT_KEY');
    var accounts = SYNC_CONFIG.accounts.filter(function (a) { return !selected || a.key === selected; });
    if (!accounts.length) throw oauthError_('OAUTH_ACCOUNT_KEY does not match a configured account.');
    accounts.forEach(function (account) {
      var key = 'busySyncPending:' + account.key;
      var old = JSON.parse(settings.props.getProperty(key) || 'null');
      if (old) oauthService_(old.serviceName).reset();
      var nonce = Utilities.getUuid(), serviceName = 'gcal-' + account.key + '-' + Utilities.getUuid();
      var pending = { serviceName: serviceName, nonce: nonce, expires: Date.now() + 3600000, email: account.email.toLowerCase(), clientId: settings.clientId };
      settings.props.setProperty(key, JSON.stringify(pending));
      var url = oauthService_(serviceName).setParam('login_hint', account.email)
        .getAuthorizationUrl({ accountKey: account.key, nonce: nonce });
      // Authorization links contain signed state, not access/refresh tokens.
      // Open them privately; do not paste these URLs into support messages.
      console.log(account.key + ' (' + account.email + '): ' + url);
    });
  });
}
function googleAccountCallback(request) {
  try {
    return withOAuthLock_(function () {
      var params = (request || {}).parameter || {};
      var account = accountDefinition_(params.accountKey);
      if (!account) throw oauthError_('Unknown account connection. Generate a new authorization link.');
      var settings = oauthSettings_(), pendingKey = 'busySyncPending:' + account.key;
      var pending = JSON.parse(settings.props.getProperty(pendingKey) || 'null');
      if (!pending || pending.nonce !== params.nonce || pending.serviceName !== params.serviceName || pending.expires < Date.now() || pending.email !== account.email.toLowerCase() || pending.clientId !== settings.clientId) throw oauthError_('Authorization link expired or changed. Generate a new link.');
      // Consume once, before exchanging the code. Preserve the old connection
      // unless this staged grant passes identity and scope verification.
      settings.props.deleteProperty(pendingKey);
      var service = oauthService_(pending.serviceName), promoted = false;
      try {
        if (!service.handleCallback(request)) throw oauthError_('Authorization was declined. Your previous connection is unchanged.');
        var token = service.getToken();
        if (!token || !token.refresh_token || !String(token.scope || '').split(/\s+/).includes(CALENDAR_SCOPE_)) throw oauthError_('Calendar permission and offline access are required. Generate a new link and approve Calendar access.');
        var response = UrlFetchApp.fetch('https://openidconnect.googleapis.com/v1/userinfo', {
          headers: { Authorization: 'Bearer ' + service.getAccessToken() }, muteHttpExceptions: true, followRedirects: false
        });
        if (response.getResponseCode() !== 200) throw oauthError_('Could not verify the selected Google account. Retry authorization.');
        var identity = JSON.parse(response.getContentText());
        var previous = oauthRecord_(account.key);
        if (identity.email_verified !== true || typeof identity.email !== 'string' || identity.email.toLowerCase() !== pending.email || !identity.sub || (previous && previous.email === pending.email && previous.sub !== identity.sub)) throw oauthError_('The selected Google account does not match the configured email. Your previous connection is unchanged.');
        settings.props.setProperty('busySyncAccount:' + account.key, JSON.stringify({ serviceName: pending.serviceName, email: pending.email, sub: identity.sub, clientId: settings.clientId }));
        promoted = true;
        if (previous) oauthService_(previous.serviceName).reset();
        return HtmlService.createHtmlOutput('Account connected. You may close this tab and run connectionStatus, then previewSync.');
      } finally {
        if (!promoted) service.reset();
      }
    });
  } catch (error) {
    // Never render Google's token response, codes, identity payload, or secrets.
    var message = error.busySyncSafe ? error.message : 'Account connection failed. Generate a new authorization link and retry.';
    return HtmlService.createHtmlOutput(message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  }
}
function connectionStatus() {
  return withOAuthLock_(function () {
    BusySync.validate(SYNC_CONFIG);
    var results = (SYNC_CONFIG.accounts || []).map(function (account) {
      try { connectedService_(account); return { account: account.key, status: 'connected' }; }
      catch (error) { return { account: account.key, status: 'unavailable', message: error.busySyncSafe ? error.message : 'Check OAuth setup.' }; }
    });
    console.log(JSON.stringify(results));
    return results;
  });
}
// Check the actual Calendar API permissions without creating any events.
function checkCalendarConnections() {
  return withOAuthLock_(function () {
    BusySync.validate(SYNC_CONFIG);
    var ids = SYNC_CONFIG.calendars.map(function (c) { return c.id; });
    var access = createCalendarAccess_(ids, PropertiesService.getScriptProperties());
    var results = ids.map(function (id, index) {
      try {
        var page = access.events.list(id, { maxResults: 1, timeMin: new Date().toISOString(), singleEvents: true });
        var role = ['owner', 'writer', 'writerWithoutPrivateAccess', 'reader', 'freeBusyReader', 'none'].indexOf(page.accessRole) >= 0 ? page.accessRole : 'unknown';
        return { calendarConfigIndex: index + 1, account: SYNC_CONFIG.calendars[index].account || 'shared', accessRole: role, ok: ['owner', 'writer', 'writerWithoutPrivateAccess'].indexOf(role) >= 0 };
      } catch (error) {
        return { calendarConfigIndex: index + 1, ok: false, message: error.busySyncSafe ? error.message : 'Calendar access failed.' };
      }
    });
    console.log(JSON.stringify(results));
    return results;
  });
}
// Select the connection with OAUTH_ACCOUNT_KEY. Retire calendars successfully
// before disconnecting so credentials remain available for cleanup.
function disconnectAccount() {
  return withOAuthLock_(function () {
    var settings = oauthSettings_(), key = settings.props.getProperty('OAUTH_ACCOUNT_KEY');
    if (!key || !/^[a-z][a-z0-9_-]{0,39}$/.test(key)) throw oauthError_('Set OAUTH_ACCOUNT_KEY to the account key to disconnect.');
    var routes = JSON.parse(settings.props.getProperty('busySyncCalendarRoutes') || '{}');
    if (SYNC_CONFIG.calendars.some(function (c) { return c.account === key; }) || Object.keys(routes).some(function (id) { return routes[id].key === key; })) throw oauthError_('Remove this account’s calendars from Config and complete sync cleanup before disconnecting.');
    var record = oauthRecord_(key), pending = JSON.parse(settings.props.getProperty('busySyncPending:' + key) || 'null');
    if (record) oauthService_(record.serviceName).reset();
    if (pending) oauthService_(pending.serviceName).reset();
    settings.props.deleteProperty('busySyncAccount:' + key);
    settings.props.deleteProperty('busySyncPending:' + key);
    console.log('Connection removed locally. You can also revoke the app in that Google account’s security settings.');
  });
}
