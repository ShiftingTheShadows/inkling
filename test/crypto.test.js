// D29: the shipping crypto slice, evaluated under Node's WebCrypto.
import { loadSlice, makeRunner } from './harness.js';

const {
  deriveSyncKey, encryptSyncPayload, decryptSyncPayload, isEncryptedSyncBlob,
  newSyncSalt, syncKeyFingerprint,
} = loadSlice('/* SYNC-CRYPTO-START */', '/* SYNC-CRYPTO-END */');
const { eq, ok, done } = makeRunner();

const PASS = 'correct horse battery staple';
const payload = {
  version: 2,
  characters: [{ id: 'c1', name: 'Vera ✦', description: 'A tired detective' }],
  chats: { c1: [{ id: 'm1', role: 'assistant', content: 'You again — “already?”' }] },
  settings: { theme: 'terminal', nested: { n: 42, flag: true, nil: null } },
};

const salt = newSyncSalt();
const key = await deriveSyncKey(PASS, salt);
const envelope = await encryptSyncPayload(payload, key, salt);

// ── envelope shape ─────────────────────────────────────────────
{
  ok('envelope is recognised', isEncryptedSyncBlob(envelope));
  eq('envelope version', envelope.v, 1);
  eq('envelope type', envelope.type, 'inkling-encrypted-backup');
  eq('envelope names the kdf', envelope.kdf.name, 'PBKDF2-SHA256');
  eq('envelope keeps the salt', envelope.kdf.salt, salt);
  eq('envelope records iteration count', envelope.kdf.iterations, 250000);
  eq('cipher is AES-GCM-256', envelope.cipher, 'AES-GCM-256');
  ok('iv is 12 bytes', atob(envelope.iv).length === 12);
  ok('plaintext payload is nowhere in the envelope', !JSON.stringify(envelope).includes('Vera'));
  ok('a normal payload is not mistaken for an envelope', !isEncryptedSyncBlob(payload));
  ok('null is not an envelope', !isEncryptedSyncBlob(null));
  ok('a half-built envelope is rejected', !isEncryptedSyncBlob({ type: 'inkling-encrypted-backup', v: 1, iv: 'x' }));
}

// ── round trip ─────────────────────────────────────────────────
{
  const back = await decryptSyncPayload(envelope, key);
  eq('round trip restores the payload exactly', back, payload);
  eq('unicode survives', back.characters[0].name, 'Vera ✦');
  eq('nested settings survive', back.settings.nested, { n: 42, flag: true, nil: null });
}

// ── wrong passphrase ───────────────────────────────────────────
{
  const wrong = await deriveSyncKey('not the right passphrase', salt);
  ok('a different passphrase derives a different key', (await syncKeyFingerprint(wrong)) !== (await syncKeyFingerprint(key)));
  let message = '';
  try { await decryptSyncPayload(envelope, wrong); } catch (e) { message = e.message; }
  ok('wrong passphrase fails with a useful message', /wrong passphrase/i.test(message), message);
  const short = await deriveSyncKey('short', salt).then(() => '', e => e.message);
  ok('short passphrases are refused at derivation', /at least 8/.test(short), short);
}

// ── tampering ──────────────────────────────────────────────────
{
  const bytes = atob(envelope.data).split('');
  const i = Math.floor(bytes.length / 2);
  bytes[i] = bytes[i] === 'A' ? 'B' : 'A';
  const tampered = { ...envelope, data: btoa(bytes.join('')) };
  let threw = false;
  try { await decryptSyncPayload(tampered, key); } catch { threw = true; }
  ok('a modified blob fails authentication instead of decrypting', threw);

  let ivThrew = false;
  try {
    await decryptSyncPayload({ ...envelope, iv: btoa('0123456789ab') }, key);
  } catch { ivThrew = true; }
  ok('a swapped IV fails authentication', ivThrew);
}

// ── salts and fingerprints ────────────────────────────────────
{
  const salt2 = newSyncSalt();
  ok('salts are random', salt !== salt2);
  const key2 = await deriveSyncKey(PASS, salt2);
  ok('same passphrase, new salt, different key', (await syncKeyFingerprint(key2)) !== (await syncKeyFingerprint(key)));
  eq('fingerprint is a stable 12-hex id', (await syncKeyFingerprint(key)).length, 12);
  eq('fingerprint is deterministic for the same key', await syncKeyFingerprint(key), await syncKeyFingerprint(key));
  const envelope2 = await encryptSyncPayload(payload, key, salt);
  ok('each push gets a fresh IV', envelope2.iv !== envelope.iv);
  ok('each push gets different ciphertext', envelope2.data !== envelope.data);
  eq('the second envelope still decrypts', await decryptSyncPayload(envelope2, key), payload);
}

done();
