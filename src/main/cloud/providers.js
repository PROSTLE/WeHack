'use strict';
// What NexaFiles needs to know about each cloud provider.
//
// One table rather than two code paths. Google Drive and Microsoft Graph differ in
// their endpoints, their scope strings and the shape of their file records, and
// nothing else about the flow differs at all — both are OAuth 2.0 authorisation
// code with PKCE, both page through a file list, both hand back a
// server-computed content hash. Keeping the differences as data means the flow
// in oauth.js is written once and a third provider is a new entry here.
//
// SCOPES ARE READ-ONLY, DELIBERATELY.
//
// NexaFiles' whole safety model is that it proposes and the user disposes. A
// token that can delete is a token that can delete by accident, or by a bug, or
// by a model that was talked into it. Neither scope below grants write access,
// so there is no code path — intended or otherwise — that can remove a file
// from anybody's cloud. Removing a synced file is still possible the way it
// always was: locally, through the plan pipeline, where the sync client carries
// it out and the user has seen exactly what will happen.
//
// NO CLIENT SECRET APPEARS HERE, and none can. A desktop application ships its
// binary to the user, so any secret inside it is readable by that user and by
// anyone else who downloads it — which is why the OAuth spec has a separate
// "public client" profile for installed apps, and why PKCE exists. The client
// id is registered by whoever runs this copy and is not a credential.

const GOOGLE = {
  id: 'google',
  label: 'Google Drive',
  // Registered by the user at console.cloud.google.com, with the Drive API
  // enabled and an OAuth client of type "Desktop app".
  registerAt: 'https://console.cloud.google.com/apis/credentials',
  registerHint:
    'Create a project, enable the "Google Drive API", then create an OAuth ' +
    'client ID of type "Desktop app". Paste the client ID here. There is no ' +
    'secret to paste — desktop clients do not use one.',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  // drive.metadata.readonly would be enough for names and hashes, but not to
  // open a file. drive.readonly is the narrowest scope that supports both, and
  // it still cannot write, rename or delete anything.
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  // Google wants these to get a refresh token at all on the first consent.
  extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  api: 'https://www.googleapis.com/drive/v3',
};

const MICROSOFT = {
  id: 'microsoft',
  label: 'OneDrive',
  registerAt: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
  registerHint:
    'Register an application, add a "Mobile and desktop applications" platform ' +
    'with the redirect URI http://localhost, and allow public client flows. ' +
    'Paste the Application (client) ID here. There is no secret to paste.',
  // "consumers" is the personal-account authority. "common" would also accept
  // work and school accounts; personal is the default because that is what a
  // OneDrive folder in a home directory usually is.
  authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  // offline_access is what yields a refresh token. Files.Read grants no write.
  scopes: ['offline_access', 'Files.Read', 'User.Read'],
  extraAuthParams: {},
  api: 'https://graph.microsoft.com/v1.0',
};

const PROVIDERS = { google: GOOGLE, microsoft: MICROSOFT };

function get(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`Unknown cloud provider "${id}".`);
  return p;
}

function list() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    registerAt: p.registerAt,
    registerHint: p.registerHint,
    scopes: p.scopes,
  }));
}

module.exports = { get, list, PROVIDERS, GOOGLE, MICROSOFT };
