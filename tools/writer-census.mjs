const incomplete = expected => expected
  ? { complete: false, externalWriters: null, expectedIsSoleHolder: false }
  : { complete: false, externalWriters: null };

const integer = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identityPart = value => (typeof value === 'bigint' && value >= 0n) || integer(value);
const inodeKey = value => {
  if (!value || !identityPart(value.dev) || !identityPart(value.ino)) throw new Error();
  return `${BigInt(value.dev)}:${BigInt(value.ino)}`;
};

const normalizedList = (items, maximum, positive = false) => {
  if (!Array.isArray(items) || items.length > maximum || items.some(n => !integer(n) || (positive && n === 0))) throw new Error();
  const sorted = [...items].sort((a, b) => a - b);
  if (sorted.some((n, i) => i > 0 && n === sorted[i - 1])) throw new Error();
  return sorted;
};

// Skipping self trusts the caller to prevent concurrent self target I/O throughout the census;
// affirmative proof checks do not establish that invariant automatically.
export async function writerCensus(options = {}) {
  const requested = options != null && Object.hasOwn(options, 'expectedHolder');
  try {
    const { reader, inventory, selfPid, controllerPids = [], proveNonWriter, skipSelfIfProven = false, limits = {}, expectedHolder } = options;
    const { maxProcesses = 4096, maxFdsPerProcess = 4096, maxOperations = 100000, timeoutMs = 5000 } = limits;
    if (![maxProcesses, maxFdsPerProcess, maxOperations, timeoutMs].every(n => integer(n) && n > 0) ||
        maxProcesses > 100000 || maxFdsPerProcess > 100000 || maxOperations > 1000000 || timeoutMs > 60000 ||
        !integer(selfPid) || selfPid === 0 || !Array.isArray(inventory) || inventory.length === 0 ||
        inventory.length > maxOperations || inventory.some(item => !item || typeof item !== 'object' ||
          Object.keys(item).length !== 2 || !Object.hasOwn(item, 'dev') || !Object.hasOwn(item, 'ino')) ||
        !reader || typeof proveNonWriter !== 'function' || typeof skipSelfIfProven !== 'boolean') return incomplete(requested);
    let expected;
    if (requested) {
      if (!expectedHolder || typeof expectedHolder !== 'object' ||
          Object.keys(expectedHolder).length !== 3 || !Object.hasOwn(expectedHolder, 'pid') ||
          !Object.hasOwn(expectedHolder, 'uid') || !Object.hasOwn(expectedHolder, 'startTime') ||
          !identityPart(expectedHolder.pid) || BigInt(expectedHolder.pid) === 0n ||
          BigInt(expectedHolder.pid) > BigInt(Number.MAX_SAFE_INTEGER) ||
          !identityPart(expectedHolder.uid) || !identityPart(expectedHolder.startTime)) return incomplete(true);
      expected = { pid: Number(expectedHolder.pid), identity: `${BigInt(expectedHolder.uid)}:${BigInt(expectedHolder.startTime)}` };
      if (skipSelfIfProven && expected.pid === selfPid) return incomplete(true);
    }
    const controllers = new Set(normalizedList(controllerPids, maxProcesses, true));
    const targets = new Set(inventory.map(inodeKey));
    let operations = 0;
    const deadline = performance.now() + timeoutMs;
    const call = async (fn, ...args) => {
      if (++operations > maxOperations || performance.now() >= deadline || typeof fn !== 'function') throw new Error();
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() => fn.apply(reader, args)),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), Math.max(0, deadline - performance.now())); })
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const processes = async () => normalizedList(await call(reader.listProcesses), maxProcesses, true);
    const descriptors = async pid => normalizedList(await call(reader.listFds, pid), maxFdsPerProcess);
    const processInfo = async pid => {
      const info = await call(reader.processInfo, pid);
      if (!info || !integer(info.uid) || !identityPart(info.startTime)) throw new Error();
      if (expected && pid === expected.pid && (!identityPart(info.pid) || BigInt(info.pid) !== BigInt(pid))) throw new Error();
      return `${info.uid}:${BigInt(info.startTime)}`;
    };
    const pass = async () => {
      const pids = await processes();
      if (!pids.includes(selfPid)) throw new Error();
      let selfIdentity;
      if (skipSelfIfProven) {
        selfIdentity = await processInfo(selfPid);
        if ((await call(proveNonWriter, selfPid)) !== true) throw new Error();
      }
      const snapshot = [];
      const holders = new Set();
      let expectedMatches = false;
      for (const pid of pids) {
        if (pid === selfPid && skipSelfIfProven) {
          snapshot.push([pid, selfIdentity, null, true]);
          continue;
        }
        const before = await processInfo(pid);
        const fds = await descriptors(pid);
        const entries = [];
        let holds = false;
        for (const fd of fds) {
          const key = inodeKey(await call(reader.statFd, pid, fd));
          entries.push([fd, key]);
          if (targets.has(key)) holds = true;
        }
        const fdsAfter = await descriptors(pid);
        const after = await processInfo(pid);
        if (before !== after || JSON.stringify(fds) !== JSON.stringify(fdsAfter)) throw new Error();
        let excluded = false;
        if (holds && (pid === selfPid || controllers.has(pid))) {
          excluded = (await call(proveNonWriter, pid)) === true;
        }
        if (holds && !excluded) holders.add(pid);
        if (expected && pid === expected.pid && before === expected.identity && holds && !excluded) expectedMatches = true;
        snapshot.push([pid, before, entries, excluded]);
      }
      if (skipSelfIfProven) {
        if ((await call(proveNonWriter, selfPid)) !== true || await processInfo(selfPid) !== selfIdentity) throw new Error();
      }
      if (JSON.stringify(pids) !== JSON.stringify(await processes())) throw new Error();
      return { snapshot: JSON.stringify(snapshot), holders: holders.size, expectedIsSoleHolder: expectedMatches && holders.size === 1 && holders.has(expected?.pid) };
    };
    let first, second;
    try {
      first = await pass();
      second = await pass();
    } catch {
      try { await processes(); } catch {}
      return incomplete(requested);
    }
    if (first.snapshot !== second.snapshot || first.holders !== second.holders || performance.now() >= deadline) return incomplete(requested);
    const result = { complete: true, externalWriters: second.holders };
    if (requested) result.expectedIsSoleHolder = first.expectedIsSoleHolder && second.expectedIsSoleHolder;
    return result;
  } catch {
    return incomplete(requested);
  }
}
