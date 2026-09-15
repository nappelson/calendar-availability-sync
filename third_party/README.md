# Bundled Google Apps Script OAuth2 library

- Upstream: https://github.com/googleworkspace/apps-script-oauth2
- Commit: `12b6d6b30a7c80e72ecb736f1318941323574a4c`
- Source: `dist/OAuth2.gs` at that commit
- Local copy: `src/OAuth2.js` (unmodified; extension changed for tooling)
- SHA-256: `73e240cdf2ad217c97fbd864e150ffc380c2220b0f040fcaa6143a81ef58ad0d`
- License: Apache-2.0, included in `OAuth2.LICENSE`; copyright headers retained.

The source is bundled so `clasp push` includes it without a separately configured Apps Script library or an unpinned runtime download. Review upstream changes, update this record, and run the full tests when upgrading.
