// A tenant's opt-in to revealing browser values, stored atomically under BROWSER_DATA like speech settings.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export class SecretSettings {
  constructor(cfg) {
    this.dir = path.join(cfg.dataDir, 'secret-settings');
    this.fallback = cfg.secretsRevealEnv ?? null;
  }

  file(tenant) { return path.join(this.dir, `${tenant}.json`); }

  get(tenant) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(this.file(tenant), 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`the secret settings cannot be read (${e.code || 'invalid JSON'})`);
    }
    const stored = typeof doc?.secrets_reveal === 'boolean' ? doc.secrets_reveal : undefined;
    return {
      settings: stored === undefined ? {} : { secrets_reveal: stored },
      effective: { secrets_reveal: stored ?? this.fallback ?? false },
      from: { secrets_reveal: stored !== undefined ? 'tenant' : this.fallback !== null ? 'env' : 'default' },
    };
  }

  set(tenant, value) {
    if (value !== null && typeof value !== 'boolean') throw new Error('secrets_reveal must be true, false or null');
    const file = this.file(tenant);
    const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(value === null ? {} : { secrets_reveal: value }), { mode: 0o600, flag: 'wx' });
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      throw new Error(`cannot save the secret settings (${e.code || 'write failed'})`);
    }
    return this.get(tenant);
  }
}
