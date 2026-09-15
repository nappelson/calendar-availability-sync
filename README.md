# Google Calendar sync: separate accounts, personal hub

Google Apps Script reads each calendar using **that account's own OAuth connection**. It copies titles, descriptions, locations, video meeting links, and an original-event link to your personal hub. All other destinations receive private **Busy** blocks. You do not need to share your work calendars with your personal account.

The script runs on Google every five minutes. Original events remain authoritative; edit and RSVP on originals. Copies have no attendees, reminders, or new conferencing objects. Attachment files and RSVP controls are not replicated. Only the event details accessible to the connected account can be copied.

## Public code, private configuration

The project information and privacy policy are at https://nappelson.github.io/calendar-availability-sync/.

`src/Config.js` is deliberately **not tracked in Git**. The public example uses fictional addresses. Keep the real configuration locally and upload it directly to your private Apps Script project with `clasp push`; it never needs to pass through GitHub. Keep a private backup when moving to another machine.

For a fresh checkout only:

```sh
cp examples/Config.example.js src/Config.js
```

Edit that local file, then create a local `.clasp.json` with your Script ID and `rootDir: "src"`. Both files are ignored by Git. OAuth credentials and grants belong in Apps Script's Script Properties, never in the repository. Never force-add ignored configuration files.

The GitHub Pages workflow publishes **only `docs/`**. It does not upload code or configuration to Apps Script. Source deployments remain a separate, local `clasp push` operation.

## Implementation and validation status

- The original shared-account sync and detailed-hub behavior are implemented.
- The user previously passed the Busy-only live Google smoke test.
- Separate-account OAuth, identity validation, token refresh, REST routing, privacy, migration, and calendar retirement have automated local coverage using the **actual bundled OAuth2 library** and simulated Google endpoints.
- **The new multi-account Google authorization/callback flow has not yet been exercised against live accounts.** Complete the connection and verification steps below before relying on scheduling protection.
- No production deployment or external Google account authorization was performed during this implementation.

## 1. Update your existing Apps Script project

1. In Apps Script, run `stopSync` if you have a schedule installed.
2. On a fresh checkout, copy `examples/Config.example.js` to `src/Config.js`. If you already have a local Config, preserve it. Edit that private file with your own `accounts`, calendar IDs, and hub:

   ```js
   var SYNC_CONFIG = {
     authMode: 'oauth',
     accounts: [
       { key: 'personal', email: 'you@gmail.com' },
       { key: 'work', email: 'you@company.com' }
     ],
     hubCalendarId: 'you@gmail.com',
     calendars: [
       { id: 'you@gmail.com', label: 'Personal', account: 'personal' },
       { id: 'you@company.com', label: 'Work', account: 'work' }
     ],
     daysAhead: 183,
     includeAllDay: true,
     includeUnanswered: true,
     includeTentative: true,
     maxChangesPerRun: 500
   };
   ```

   Use the exact Google account sign-in email and Calendar IDs. Keys are stable lowercase identifiers; labels appear as `Source calendar: <label>` at the top of detailed hub copies. If a label is missing or blank, the Calendar ID is used. Changing a label updates existing hub copies on the next sync; Busy-only destinations do not receive source labels. A secondary calendar uses its own Calendar ID, with the key of an account authorized to access it. The hub must appear in `calendars`. Set it to `null` for Busy-only everywhere.
3. From this repository on your Mac mini:

   ```sh
   npm test
   npm run check
   clasp show-file-status
   clasp push
   ```

   `.clasp.json` should target the existing Script ID with `rootDir: "src"`. Confirm the file list includes `Auth`, `CalendarAccess`, `OAuth2`, `Core`, `Code`, `Config`, and `appsscript.json`. Tests and docs must not upload. The bundled OAuth2 source needs no manually added library.
4. **Keep the existing Script Properties.** `busySyncOwner` identifies existing copies; `busySyncCalendars` tracks cleanup. The OAuth migration adds connection routing without changing these identities. Existing copies are updated in place.
5. Refresh Apps Script. Its manifest adds `script.external_request`; approve the updated script authorization when prompted. The retained Calendar service scope supports the legacy mode/test; production OAuth requests use each account's separate token.

`clasp push` overwrites the online source files, including Config, but does not overwrite Script Properties. Keep configuration edits local. A `clasp` login only authorizes source upload; it does not connect calendars to the sync.

## 2. One-time Google Cloud OAuth setup

1. Open https://console.cloud.google.com/ and create/select a project you control.
2. Enable **Google Calendar API** in that project.
3. Configure **Google Auth Platform → Branding** (app name/support email), **Audience → External**, and **Data Access**. Request:
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email` (the OAuth request uses its `email` shorthand)
   - `https://www.googleapis.com/auth/calendar.events`
4. While the app is in **Testing**, add each connecting Google email under test users.
5. Create a **Web application** OAuth client under **Clients**.
6. Add this exact **Authorized redirect URI**, using the ID of your existing Apps Script project (not its deployment ID or Cloud project ID):

   ```text
   https://script.google.com/macros/d/YOUR_SCRIPT_ID/usercallback
   ```

7. In **Apps Script → Project Settings → Script Properties**, add:

   | Property | Value |
   | --- | --- |
   | `GOOGLE_OAUTH_CLIENT_ID` | The new client's ID |
   | `GOOGLE_OAUTH_CLIENT_SECRET` | The new client's secret |

   Do not put these in Config, Git, or chat. The OAuth client can be in a different Cloud project from Apps Script's default project. No web-app deployment is needed: the library uses Apps Script's built-in user callback.
8. Run `oauthSetupInfo`. It prints the required callback URI, client ID, and scopes, **not the client secret**. Check the URI exactly matches the one saved on the OAuth client.

For unattended use, move the external OAuth app out of **Testing**. Google issues Calendar refresh tokens lasting only seven days in Testing; reconnect after changing publishing status. Production publishing is not the same as Google verification. An unverified personal-use app can show a warning and has user limits; organization policy may require approval or block it. Publishing alone does not override those policies.

## 3. Connect the accounts

1. Run `showAuthorizationLinks` from the Apps Script editor. It prints one Google authorization URL for each account in Config. Open these privately; do not share the authorization URLs in support messages.
2. Open the personal link, select the personal account, and approve Calendar access.
3. Open the work link, select the work account, and approve Calendar access.
4. Each successful callback says **Account connected**. The script checks the actual verified Google email returned by the token's user-info endpoint. Selecting the wrong account does not replace an existing connection.
5. Run `connectionStatus`. Each account should say **connected**. This also exercises automatic token refresh if needed.
6. Run `checkCalendarConnections`. Each calendar should report `ok: true`, typically `accessRole: owner`. This checks the actual Calendar API using each grant without creating any events.

Always manage the Apps Script project and its triggers using your personal account. The work account signs in at Google's OAuth consent screen; it does not need to become a project editor or receive calendar-sharing access. If the callback fails because the browser is using the wrong Apps Script session, return to the personal account's script session and generate a fresh link.

Authorization URLs expire after one hour. Generating a new link for an account invalidates the previous pending link. Reconnection is staged; denial, wrong email, or missing Calendar/offline permission leaves the previous working connection intact.

To reconnect only one account, set `OAUTH_ACCOUNT_KEY` in Script Properties to `work` (or another key), then run `showAuthorizationLinks`. Delete that property to generate links for all accounts again.

## 4. Verify and schedule

1. Run `previewSync` and inspect `planned` counts. This makes no event changes.
2. Run `syncCalendars`, then verify a work event appears with details on your personal hub and a personal event appears as **Busy** at work.
3. Run it again with no source changes: `applied` should be zero.
4. For a live functional check, create a clearly named short future test event on one source. Sync, verify the copy, change its time and description, sync again, then delete the source and verify its copies disappear. Repeat from the other account. Copies should never include attendees or send invitations.
5. Run `installSync`. It validates with preview, then installs a five-minute trigger. In the Triggers screen, configure failure notifications to **immediately**.

Before using real primary calendars for the functional check, you can instead configure two temporary secondary calendars you manually create (one in each account, using the same connected account keys). Run preview and the functional checks on those IDs. If this installation already tracks production calendars, changing the set retires them and removes their generated blocks; avoid that by testing in a separate project or doing the small source-event check above.

## Add and remove accounts/calendars

### Add a calendar under an already connected account

Add `{ id: 'calendar-id', label: 'Name', account: 'work' }` to Config, `clasp push`, run `checkCalendarConnections`, preview, then sync. No new authorization is needed if the connected account already has sufficient access.

### Add another account

Add `{ key: 'newwork', email: 'you@newcompany.com' }` to `accounts` and the calendar(s) with `account: 'newwork'`. Push. Set `OAUTH_ACCOUNT_KEY` to `newwork`, run `showAuthorizationLinks`, authorize, then check/preview/sync.

### Remove a calendar

Remove its entry, push, preview, then sync. Keep the connection authorized until cleanup succeeds. The script removes its generated blocks on the retired calendar and its contributions on the remaining calendars; originals stay untouched. If removing the hub, choose another hub or set `hubCalendarId: null` too.

### Disconnect an account

Remove its calendars and successfully sync cleanup first. Set `OAUTH_ACCOUNT_KEY` to its key, then run `disconnectAccount`. You can remove the account definition too. The saved retirement route retains the needed account/email until calendar cleanup finishes. Disconnect refuses while active calendars or pending retirement routes still need the credentials.

Disconnect deletes the locally stored grant; it does not call Google's app-wide revocation endpoint. You may revoke the app separately in that Google account's security settings. Revoking before cleanup may leave stale Busy blocks until you reconnect and finish cleanup.

## Functions

| Function | Behavior |
| --- | --- |
| `oauthSetupInfo` | Show callback URI/client ID, without secret |
| `showAuthorizationLinks` | Generate sign-in links; optionally select via `OAUTH_ACCOUNT_KEY` |
| `connectionStatus` | Check grants and refresh expired access tokens |
| `checkCalendarConnections` | Read-only Calendar API access check |
| `disconnectAccount` | Forget selected grant after retirement cleanup |
| `previewSync` | Plan changes without event writes |
| `syncCalendars` | Sync now |
| `installSync` | Validate and install five-minute scheduling |
| `stopSync` | Stop scheduling; leave existing copies |
| `syncStatus` | Last run, safe errors, counts, last successful sync |
| `previewCleanup` | Preview removal of all this installation's copies |
| `cleanupAllBlocks` | Stop scheduling and remove owned copies |

## Rules and safety

- Every calendar is a source and destination. Generated copies are never used as sources, so hub details cannot spread to work calendars through this script.
- By default, the rolling next 183 days include busy all-day, tentative, and unanswered events. Declined, cancelled, free, birthday, and working-location events are excluded. Hidden invitations follow Google's default exclusion.
- Google expands recurring events; each occurrence is tracked separately. Duplicate invitation copies suppress blocks only when identity and actual intervals match. Conflicting times protect both intervals until originals agree.
- All-day events retain named dates, including Google's exclusive end date. Different calendar time zones can produce different UTC intervals for the same date.
- Every account's grant and every page of calendar reads must succeed before writes begin. Missing/revoked tokens or failed reads preserve existing blocks.
- Ownership markers and hashed source IDs protect originals. Reads and writes use the configured account route, and ownership is checked again before changing a copy.
- Creates/updates precede deletions. Writes are not atomic; a failed run can be partially applied. No immediate retries of ambiguous writes; the next run reconciles committed changes.
- A script lock serializes sync, callbacks, and account operations. The OAuth library uses that same lock for refresh without releasing an already-held lock.
- Cleanup acquires the lock and validates its plan before stopping triggers. If writes later fail, rerun cleanup manually.
- More than `maxChangesPerRun` (default 500) changes rejects the whole plan before writes. Review counts and deliberately increase the cap if initial population needs it. It is not batching.
- Queries above 20,000 returned events stop. Reads have a four-minute budget and must all succeed before calendar writes. Writes pause after about 3.5 minutes with `ok: true`, `complete: false`, `stage: "partial"`, and a `remaining` count. Run `syncCalendars` again (or let the existing five-minute trigger run) until `complete: true`. Each run re-reads calendars and replans; committed copies are not recreated. The last successful sync timestamp advances only after a complete non-preview sync. Partial cleanup retains retirement metadata and must be continued by running `cleanupAllBlocks` again, since cleanup stops scheduling. The configured change limit still applies to the entire remaining plan. Google quotas still apply, including total daily trigger runtime.
- Expired historical generated blocks are removed. Original historical events are never removed.
- A five-minute schedule is approximate and cannot prevent every double booking between runs.

## Credentials and recovery

One pinned dependency is bundled: Google's Apache-2.0 OAuth2 library; see `third_party/README.md`. It renews access tokens with stored refresh tokens. A revoked/expired refresh token or organization restriction can require reconnection. No regular sign-in is needed while refresh tokens remain valid.

Client credentials, refresh/access tokens, pending nonces, and connection identity records are in **Script Properties**, accessible to project editors. This is not a separate encrypted vault. Keep the Apps Script project private, avoid adding other editors, protect your Google account, and never publish a web endpoint that exposes properties. Each grant has Calendar event read/write access, broader than only generated Busy blocks. The script does not request Gmail or Drive access.

Google token/API response bodies are not logged or rendered. Status errors show only fixed messages, HTTP status, and configured account keys. Authorization links intentionally appear only when you run `showAuthorizationLinks`; treat those links as private.

Do not delete `busySyncOwner`, `busySyncCalendars`, `busySyncCalendarRoutes`, or OAuth properties to troubleshoot. Lost ownership metadata prevents reliable cleanup of old copies. Changing the OAuth client ID or a connection's email requires reconnection. Preserve account keys through calendar retirement.

For a pre-OAuth retired calendar with no route, temporarily restore its Config entry with the correct account key, sync once, then remove it again. For normal OAuth retirement, routes are saved automatically before writes.

To uninstall: preview cleanup → cleanup all blocks → verify success → disconnect accounts/revoke grants → delete the project. Stopping scheduling alone leaves copies.

## Tests

```sh
npm test
npm run check
```

Requires Node 18+; no npm dependencies. Tests cover the actual sync adapter and bundled OAuth2 library against fake Google endpoints: identity checks, consent denial, callback nonce/replay protection, token refresh/failure, per-account REST routing, pagination, privacy, updates, recurrence, cancellation, DST, duplicate invitations, hub changes, retirement, ownership migration, and cleanup contention. Mocked state tokens do not verify Google's actual callback transport; live authorization remains a setup check.

The older `test/live/SmokeTest.gs` tests the sync engine using disposable calendars in **shared mode**, not OAuth account connections. Use only a fresh disposable test project: copy all `src` files, set `calendars: []` and `hubCalendarId: null`, add the SmokeTest file, and add the `calendar.calendars` scope to the test manifest. It creates/deletes fixtures and runs all-way/recurrence/hub tests. Do not add that scope to production OAuth grants. Run `cleanupSmokeFixtures` if a test is interrupted; manually remove any orphaned `BusySync disposable test …` calendars if a create committed without returning an ID.

## References

- https://github.com/googleworkspace/apps-script-oauth2
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/identity/protocols/oauth2#expiration
- https://developers.google.com/workspace/calendar/api/v3/reference/events
- https://developers.google.com/apps-script/guides/services/quotas
