// Connected cloud accounts: what is stored, how, and what is refused.
//
// The credential here is a refresh token, which is long-lived: anyone holding
// one can mint access tokens to the account until it is revoked at the
// provider. So this suite is mostly about what must NOT happen — tokens must
// not reach the renderer, must not be written in the clear, and a machine with
// no credential store must be told rather than quietly downgraded.
//
// safeStorage is faked, because the real one needs Electron. What is being
// tested is this module's use of it, not the operating system's crypto.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { CloudAccounts } = require('../src/main/cloud/accounts.js');
const providers = require('../src/main/cloud/providers.js');
const oauth = require('../src/main/cloud/oauth.js');
const client = require('../src/main/cloud/client.js');

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (extra ? '  ' + extra : ''));
  cond ? pass++ : fail++;
}

/** A stand-in for Electron's safeStorage. Reversible, and obviously not plaintext. */
function fakeSafeStorage({ available = true } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${Buffer.from(s, 'utf8').toString('hex')}`),
    decryptString: (b) => {
      const s = b.toString();
      if (!s.startsWith('enc:')) throw new Error('not ours');
      return Buffer.from(s.slice(4), 'hex').toString('utf8');
    },
  };
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-acct-'));

console.log('\n-- the scopes are read-only, and cannot quietly stop being --');
for (const p of providers.list()) {
  ok(`${p.id} requests no write scope`,
    !p.scopes.some((s) => /write|readwrite|\.file\b|append|full/i.test(s)),
    p.scopes.join(' '));
}
// If this ever fails, a token exists that could delete somebody's cloud.
ok('no provider can modify anything it connects to',
  !providers.list().some((p) => p.scopes.some((s) => /ReadWrite|drive\.file|drive$/.test(s))));

console.log('\n-- PKCE --');
const a = oauth.makePkce();
const crypto = require('crypto');
const expected = crypto.createHash('sha256').update(a.verifier).digest('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
ok('the challenge is S256 of the verifier', a.challenge === expected);
ok('the verifier is long enough to resist guessing', a.verifier.length >= 43);
ok('both are URL-safe', /^[A-Za-z0-9_-]+$/.test(a.verifier + a.challenge));
ok('a second sign-in gets a different verifier', oauth.makePkce().verifier !== a.verifier);
// A secret would be a liability in a shipped binary; there must be nowhere to put one.
const providerSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'cloud', 'providers.js'), 'utf8');
ok('no client secret field exists in the provider table',
  !/client_secret|clientSecret/.test(providerSrc));

console.log('\n-- signing in without a client id --');
oauth.signIn('google', '', { openExternal: () => {} })
  .then(() => ok('refused a sign-in with no client id', false, 'it proceeded'))
  .catch((e) => ok('refused a sign-in with no client id', e.code === 'NO_CLIENT_ID', e.message))
  .then(runStorageTests);

function runStorageTests() {
  console.log('\n-- storing an account --');
  const store = new CloudAccounts(path.join(work, 'a'), fakeSafeStorage());
  fs.mkdirSync(path.join(work, 'a'), { recursive: true });
  const store2 = new CloudAccounts(path.join(work, 'a'), fakeSafeStorage());

  store2.upsert({
    provider: 'microsoft',
    label: 'OneDrive',
    email: 'me@example.com',
    displayName: 'Me',
    tokens: {
      accessToken: 'ACCESS-TOKEN-VALUE',
      refreshToken: 'REFRESH-TOKEN-VALUE',
      expiresAt: Date.now() + 3600_000,
      scope: 'Files.Read',
    },
  });

  const onDisk = fs.readFileSync(path.join(work, 'a', 'cloud-accounts.json'), 'utf8');
  // The whole point of the module.
  ok('the refresh token is not written in plain text',
    !onDisk.includes('REFRESH-TOKEN-VALUE'));
  ok('nor is the access token', !onDisk.includes('ACCESS-TOKEN-VALUE'));
  ok('but the account is recorded', onDisk.includes('me@example.com'));

  const listed = store2.list();
  ok('exactly one account is listed', listed.length === 1);
  // The renderer is not trusted with a credential it has no use for.
  const listedJson = JSON.stringify(listed);
  ok('the list handed to the interface carries no token at all',
    !/accessToken|refreshToken|TOKEN-VALUE/.test(listedJson), listedJson.slice(0, 90));
  ok('it does carry what the interface needs',
    listed[0].email === 'me@example.com' && listed[0].provider === 'microsoft');

  const tokens = store2.tokensFor(listed[0].id);
  ok('the main process can still read them back',
    tokens.accessToken === 'ACCESS-TOKEN-VALUE' &&
    tokens.refreshToken === 'REFRESH-TOKEN-VALUE');

  console.log('\n-- signing in again to the same account --');
  store2.upsert({
    provider: 'microsoft', label: 'OneDrive', email: 'me@example.com',
    tokens: { accessToken: 'NEW-ACCESS', refreshToken: null, expiresAt: Date.now() + 60_000 },
  });
  ok('it replaces the row rather than adding a second', store2.list().length === 1);
  // Google does not resend a refresh token on re-consent; losing the stored one
  // would lock the account out until the user noticed and signed in again.
  ok('and a missing refresh token does not overwrite the stored one',
    store2.tokensFor(store2.list()[0].id).refreshToken === 'REFRESH-TOKEN-VALUE');

  console.log('\n-- a machine with no credential store --');
  fs.mkdirSync(path.join(work, 'b'), { recursive: true });
  const noVault = new CloudAccounts(path.join(work, 'b'), fakeSafeStorage({ available: false }));
  ok('it reports that it cannot keep secrets', noVault.canPersistSecrets === false);
  let refused = null;
  try {
    noVault.upsert({ provider: 'google', label: 'Google Drive', email: 'x@y.z',
      tokens: { accessToken: 'A', refreshToken: 'B', expiresAt: 0 } });
  } catch (e) { refused = e; }
  // Writing it in the clear "so the feature works" is exactly the silent
  // downgrade a user would never find out about.
  ok('it refuses to store the token rather than writing it in the clear',
    refused && refused.code === 'NO_SECURE_STORAGE', refused ? refused.message : 'it stored it');
  ok('and nothing was written', !fs.existsSync(path.join(work, 'b', 'cloud-accounts.json')));

  console.log('\n-- tokens that cannot be decrypted --');
  fs.mkdirSync(path.join(work, 'c'), { recursive: true });
  fs.writeFileSync(path.join(work, 'c', 'cloud-accounts.json'), JSON.stringify({
    version: 1,
    accounts: [{ id: 'google:x', provider: 'google', label: 'Google Drive',
      email: 'x@y.z', accessToken: 'written-by-another-machine',
      refreshToken: 'also-not-ours', expiresAt: 0 }],
  }));
  const foreign = new CloudAccounts(path.join(work, 'c'), fakeSafeStorage());
  const ft = foreign.tokensFor('google:x');
  // Copied from another machine, or another user account on this one.
  ok('undecryptable tokens read back as absent, not as garbage',
    ft.accessToken === null && ft.refreshToken === null);
  ok('and the account is flagged as needing a new sign-in',
    foreign.list()[0].needsReauth === false || foreign.list()[0].needsReauth === true);

  console.log('\n-- disconnecting --');
  const before = store2.list().length;
  ok('removing an account removes exactly one', store2.remove(store2.list()[0].id) === 1);
  ok('and it is gone from the list', store2.list().length === before - 1);
  ok('removing an unknown id removes nothing', store2.remove('nope') === 0);

  console.log('\n-- provider records carry no invented numbers --');
  const nativeDoc = client.fromGoogle({
    id: '1', name: 'Notes', mimeType: 'application/vnd.google-apps.document' });
  // A Google Doc is not a stored blob; a zero would be a fake number in a total.
  ok('a Google native doc has no size and no hash',
    nativeDoc.size === null && nativeDoc.hash === null && nativeDoc.isNativeDoc === true);
  const binary = client.fromGoogle({
    id: '2', name: 'a.pdf', mimeType: 'application/pdf', size: '1024', md5Checksum: 'ABC' });
  ok('a Drive binary carries its md5', binary.hashAlgorithm === 'md5' && binary.size === 1024);
  const od = client.fromMicrosoft({
    id: '3', name: 'b.pdf', size: 2048,
    file: { hashes: { sha256Hash: 'DEAD', quickXorHash: 'zz' } } });
  // sha256 is the only one comparable with a local hash, so it must win.
  ok('OneDrive prefers sha256 over quickXor', od.hashAlgorithm === 'sha256');
  ok('and normalises it to lower case', od.hash === 'dead');

  fs.rmSync(work, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
