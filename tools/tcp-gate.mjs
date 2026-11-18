import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import net from 'node:net';

// Experimental only. Assumes Linux, one host and network namespace, cooperative
// gate-aware participants, and no malicious process with the same UID or root.
// A lost gate cannot establish that in-flight I/O has stopped. In particular,
// asynchronous close/error notification and directory replacement leave races;
// this mechanism must not be treated as production-safe.
export function portForIdentity(dev, ino) {
  const digest = createHash('sha256').update(`${dev}:${ino}`).digest();
  return 1024 + digest.readUInt32BE(0) % (65536 - 1024);
}

// The callback must settle only after all of its protected work has settled.
// On uncertainty the caller must not start a conflicting process. A timeout
// signals cancellation but does not release the socket until the callback settles.
export async function withTcpGate(dataDir, work, { timeoutMs = 0 } = {}) {
  if (typeof work !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647) {
    throw new TypeError('Invalid gate arguments');
  }

  let info;
  try {
    info = await stat(await realpath(dataDir), { bigint: true });
    if (!info.isDirectory()) return { status: 'IDENTITY_UNAVAILABLE' };
  } catch {
    return { status: 'IDENTITY_UNAVAILABLE' };
  }

  const server = net.createServer(socket => socket.destroy());
  const controller = new AbortController();
  let lost = false;
  let releasing = false;
  const markLost = () => { lost = true; controller.abort(); };
  server.on('error', markLost);
  server.on('close', () => { if (!releasing) markLost(); });

  const acquired = await new Promise(resolve => {
    const onError = () => resolve(false);
    server.once('error', onError);
    try {
      server.listen({ host: '127.0.0.1', port: portForIdentity(info.dev, info.ino), exclusive: true }, () => {
        server.off('error', onError);
        resolve(true);
      });
    } catch {
      server.off('error', onError);
      resolve(false);
    }
  });
  if (!acquired) return { status: 'GATE_UNAVAILABLE' };

  let timedOut = false;
  const timer = timeoutMs ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs) : undefined;
  let value;
  let failed = false;
  try {
    value = await work({ signal: controller.signal });
  } catch {
    failed = true;
  } finally {
    clearTimeout(timer);
  }

  if (!server.listening) lost = true;
  releasing = true;
  const closed = await new Promise(resolve => {
    try { server.close(error => resolve(!error)); } catch { resolve(false); }
  });
  if (!closed || lost || timedOut) return { status: 'OPERATION_UNCONFIRMED' };
  if (failed) return { status: 'OPERATION_FAILED' };
  return { status: 'OK', value };
}
