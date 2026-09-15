// Copy to src/Config.js locally. That file is excluded from Git.
// Use exact Calendar IDs, never the alias "primary".
var SYNC_CONFIG = {
  authMode: 'oauth',
  accounts: [
    { key: 'personal', email: 'personal@example.com' },
    { key: 'work', email: 'work@example.com' }
  ],
  hubCalendarId: 'personal@example.com',
  calendars: [
    { id: 'personal@example.com', label: 'Personal', account: 'personal' },
    { id: 'work@example.com', label: 'Work', account: 'work' }
  ],
  daysAhead: 183,
  includeAllDay: true,
  includeUnanswered: true,
  includeTentative: true,
  maxChangesPerRun: 500
};
