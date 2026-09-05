'use strict';
// Connected cloud accounts, and their tokens.
//
// A refresh token is a long-lived credential: anyone holding one can mint
// access tokens to the account until it is revoked. It therefore does not go
// where the Gemini key goes — settings.json, plain text — and this is the one
// place in NexaFiles that encrypts what it stores.
//
// Electron's safeStorage is the encryption, which means the operating system's
// own facility: DPAPI on Windows, the Keychain on macOS, the secret service on
// Linux. The key is bound to the logged-in user, so the file is unreadable by
// another account on the same machine and unreadable if copied off it.
//
// Where safeStorage is unavailable — a Linux box with no keyring — tokens are
// NOT written in the clear as a convenience. The account simply does not
// persist, and the user is told why. Silently downgrading the protection on a
// credential is precisely the kind of thing a user would never find out about.

const fs = require('fs');
const path = require('path');

const FILE = 'cloud-accounts.json';

class CloudAccounts {
  /**
   * @param {string} userDataDir
   * @param {object} safeStorage Electron's safeStorage, injected so this is
   *   testable without launching a browser window
   */
  constructor(userDataDir, safeStorage) {
    this.file = path.join(userDataDir, FILE);
    this.safeStorage = safeStorage || null;
    this.accounts = [];
    this.load();
  }

  get canPersistSecrets() {
    try { return !!this.safeStorage?.isEncryptionAvailable?.(); }
    catch { return false; }
  }

  _encrypt(value) {
    if (!value) return null;
    if (!this.canPersistSecrets) return null;
    return this.safeStorage.encryptString(String(value)).toString('base64');
  }

  _decrypt(blob) {
    if (!blob || !this.canPersistSecrets) return null;
    try {
      return this.safeStorage.decryptString(Buffer.from(blob, 'base64'));
    } catch {
      // Written by a different user or a different machine. Not an error to
      // throw over — it means "sign in again", which is what the caller does.
      return null;
    }
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
    } catch {
      this.accounts = [];
    }
    return this.accounts;
  }

  save() {
    try {
      fs.writeFileSync(
        this.file,
        JSON.stringify({ version: 1, accounts: this.accounts }, null, 2),
        { encoding: 'utf8', mode: 0o600 }
      );
    } catch (err) {
      console.warn(`[cloud] accounts could not be saved: ${err.message}`);
    }
    return this.accounts;
  }

  /** Everything the renderer may see. Never a token, encrypted or otherwise. */
  list() {
    return this.accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      label: a.label,
      email: a.email || null,
      displayName: a.displayName || null,
      connectedAt: a.connectedAt,
      lastImportAt: a.lastImportAt || null,
      fileCount: a.fileCount || 0,
      quota: a.quota || null,
      scope: a.scope || null,
      // Whether this account can act right now, and if not, why.
      needsReauth: !a.refreshToken,
    }));
  }

  get(id) {
    return this.accounts.find((a) => a.id === id) || null;
  }

  find(provider, email) {
    return this.accounts.find(
      (a) => a.provider === provider && (a.email || null) === (email || null)) || null;
  }

  /**
   * Stores a signed-in account.
   *
   * Signing in again to an account already present replaces its tokens rather
   * than adding a second row, so the list stays one entry per real account.
   */
  upsert({ provider, label, email, displayName, tokens, quota = null }) {
    if (!this.canPersistSecrets) {
      const err = new Error(
        'This machine has no secure credential store available, so NexaFiles will ' +
        'not save a cloud sign-in. It refuses to write a refresh token in plain ' +
        'text, because anyone who reads that file would have access to the account.');
      err.code = 'NO_SECURE_STORAGE';
      throw err;
    }

    const existing = this.find(provider, email);
    const row = existing || {
      id: `${provider}:${email || Date.now()}`,
      provider,
      connectedAt: new Date().toISOString(),
    };

    row.label = label;
    row.email = email || null;
    row.displayName = displayName || null;
    row.scope = tokens.scope || null;
    row.accessToken = this._encrypt(tokens.accessToken);
    row.refreshToken = this._encrypt(tokens.refreshToken) || row.refreshToken || null;
    row.expiresAt = tokens.expiresAt || 0;
    if (quota) row.quota = quota;

    if (!existing) this.accounts.push(row);
    this.save();
    return row;
  }

  /** The decrypted tokens for one account, for use in this process only. */
  tokensFor(id) {
    const a = this.get(id);
    if (!a) return null;
    return {
      accessToken: this._decrypt(a.accessToken),
      refreshToken: this._decrypt(a.refreshToken),
      expiresAt: a.expiresAt || 0,
    };
  }

  /** Records refreshed tokens without disturbing the rest of the row. */
  updateTokens(id, tokens) {
    const a = this.get(id);
    if (!a) return null;
    a.accessToken = this._encrypt(tokens.accessToken);
    if (tokens.refreshToken) a.refreshToken = this._encrypt(tokens.refreshToken);
    a.expiresAt = tokens.expiresAt || 0;
    this.save();
    return a;
  }

  /** Records what an import found, for the interface to report. */
  noteImport(id, { fileCount, quota }) {
    const a = this.get(id);
    if (!a) return null;
    a.lastImportAt = new Date().toISOString();
    if (typeof fileCount === 'number') a.fileCount = fileCount;
    if (quota) a.quota = quota;
    this.save();
    return a;
  }

  /**
   * Forgets an account.
   *
   * The tokens go from this machine. That is not the same as revoking them at
   * the provider, which only the provider can do, and the interface says so
   * rather than implying this disconnects anything on their end.
   */
  remove(id) {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((a) => a.id !== id);
    if (this.accounts.length !== before) this.save();
    return before - this.accounts.length;
  }
}

module.exports = { CloudAccounts };
