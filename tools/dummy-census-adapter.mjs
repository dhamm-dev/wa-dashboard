const fixturePattern = /^\/home\/dhexct528dec24\/\.dummy-db-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.sqlite$/;
const fail = () => Object.assign(new Error('Dummy DB operation unconfirmed'), { code: 'OPERATION_UNCONFIRMED' });
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const startTime = value => (typeof value === 'bigint' && value > 0n) || integer(value, 1);
const sameInode = (value, identity) => value && value.dev === identity.dev && value.ino === identity.ino;

// Caller must isolate the scanner process: no concurrent target I/O or other work during census.
// Fixture and target observations must finish before census; the guard is an attestation, not proof.
export function createDummyCensusAdapter(options = {}) {
  try {
    const { fixturePath, identity, observeTarget, statFixture, reader, censusImpl, proveNoSelfTargetIo } = options;
    if (typeof fixturePath !== 'string' || !fixturePattern.test(fixturePath) ||
        !identity || !integer(identity.dev) || !integer(identity.ino, 1) ||
        typeof observeTarget !== 'function' || typeof statFixture !== 'function' ||
        typeof censusImpl !== 'function' || typeof proveNoSelfTargetIo !== 'function' ||
        !reader || typeof reader !== 'object') throw fail();
    const inode = Object.freeze({ dev: identity.dev, ino: identity.ino });
    let busy = false;
    const fileCheck = value => {
      if (!sameInode(value, inode) || value.regular !== true || value.symlink !== false ||
          value.uid !== 999 || value.gid !== 983 || value.mode !== 0o600 || value.nlink !== 1) throw fail();
    };
    const targetCheck = value => {
      if (!value || value.verified !== true) throw fail();
      if (value.active === false && value.pid === 0) return Object.freeze({ active: false });
      if (value.active !== true || !integer(value.pid, 1) || value.uid !== 999 ||
          !startTime(value.startTime) || !sameInode(value.fd0, inode)) throw fail();
      return Object.freeze({ active: true, pid: value.pid, uid: value.uid, startTime: BigInt(value.startTime) });
    };
    return async request => {
      if (busy) throw fail();
      busy = true;
      try {
        if (!request || request.synthetic !== true || request.path !== fixturePath ||
            !sameInode(request.identity, inode)) throw fail();
        fileCheck(await statFixture(fixturePath));
        const before = targetCheck(await observeTarget());
        if (await proveNoSelfTargetIo() !== true) throw fail();
        const options = { reader, inventory: [inode], selfPid: process.pid,
          proveNonWriter: async pid => pid === process.pid && await proveNoSelfTargetIo() === true,
          skipSelfIfProven: true, limits: { timeoutMs: 2500 } };
        if (before.active) options.expectedHolder = { pid: before.pid, uid: before.uid, startTime: before.startTime };
        const result = await censusImpl(options);
        if (!result || result.complete !== true || result.externalWriters !== (before.active ? 1 : 0) ||
            (before.active && result.expectedIsSoleHolder !== true)) throw fail();
        if (await proveNoSelfTargetIo() !== true) throw fail();
        const after = targetCheck(await observeTarget());
        if (before.active !== after.active || (before.active &&
            (before.pid !== after.pid || before.uid !== after.uid || before.startTime !== after.startTime))) throw fail();
        fileCheck(await statFixture(fixturePath));
        return { synthetic: true, path: fixturePath, ...inode, complete: true, pids: before.active ? [before.pid] : [] };
      } catch {
        throw fail();
      } finally {
        busy = false;
      }
    };
  } catch {
    throw fail();
  }
}
