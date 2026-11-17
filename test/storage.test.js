// Storage failure classification — the map from an IndexedDB/localStorage error
// to the message the banner shows. Pure: the reporter itself needs a database.
import { loadSlice, makeRunner } from './harness.js';

const { storageErrorKind } = loadSlice('/* STORAGE-EXPORTS-START */', '/* STORAGE-EXPORTS-END */');
const { eq, done } = makeRunner();

const dom = (name, message) => {
  try { return new DOMException(message || name, name); } catch { return { name, message }; }
};

eq('quota by DOMException name', storageErrorKind(dom('QuotaExceededError', 'nope')), 'quota');
eq('quota by numeric code', storageErrorKind({ code: 22, message: 'x' }), 'quota');
eq('quota by message', storageErrorKind(new Error('The disk is full')), 'quota');
eq('blocked by SecurityError', storageErrorKind(dom('SecurityError', 'denied')), 'blocked');
eq('blocked by message', storageErrorKind(new Error('storage is not allowed here')), 'blocked');
eq('unavailable', storageErrorKind(dom('InvalidStateError', 'backing store closed')), 'unavailable');
eq('unknown name', storageErrorKind(new Error('boom')), 'unknown');
eq('null', storageErrorKind(null), 'unknown');
eq('string', storageErrorKind('quota exceeded'), 'quota');

done();
