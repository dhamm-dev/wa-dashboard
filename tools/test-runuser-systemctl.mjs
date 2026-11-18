import { randomUUID } from 'node:crypto';

const invalid = () => new Error('Invalid synthetic unit evidence');
const defaults = new Set(['basic.target', 'shutdown.target', 'sysinit.target']);
const keysMatch = (object, keys) => object !== null && typeof object === 'object' && !Array.isArray(object) &&
  Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));

function validate(evidence, unit, uid) {
  try {
    if (!keysMatch(evidence, ['id', 'names', 'transient', 'ownerUid', 'execStart', 'dependencies', 'cgroup']) ||
        evidence.id !== unit || evidence.transient !== true || evidence.ownerUid !== uid ||
        !Array.isArray(evidence.names) || evidence.names.length !== 1 || evidence.names[0] !== unit ||
        !Array.isArray(evidence.execStart) || evidence.execStart.length !== 1 || evidence.execStart[0] !== '/usr/bin/sleep' ||
        !Array.isArray(evidence.dependencies) || evidence.dependencies.some(name => !defaults.has(name)) ||
        new Set(evidence.dependencies).size !== evidence.dependencies.length ||
        !keysMatch(evidence.cgroup, ['synthetic', 'ownerUid', 'unit']) || evidence.cgroup.synthetic !== true ||
        evidence.cgroup.ownerUid !== uid || evidence.cgroup.unit !== unit) throw invalid();
  } catch {
    throw invalid();
  }
}

export function createSyntheticUnitValidator({ ownerUid, inspect } = {}) {
  if (!Number.isSafeInteger(ownerUid) || ownerUid <= 0 || typeof inspect !== 'function') throw invalid();
  const capabilities = new WeakMap();

  return Object.freeze({
    create() {
      const unit = `dhexbot-cutover-test-${randomUUID()}.service`;
      const capability = Object.freeze(Object.create(null));
      capabilities.set(capability, unit);
      return Object.freeze({ unit, capability });
    },
    async verify(capability) {
      try {
        const unit = capabilities.get(capability);
        if (!unit) throw invalid();
        const evidence = await inspect(unit);
        validate(evidence, unit, ownerUid);
        return Object.freeze({ unit, ownerUid });
      } catch {
        throw invalid();
      }
    },
  });
}
