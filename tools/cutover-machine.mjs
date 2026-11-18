export async function runCutover(operations, { timeoutMs = 1000, timeouts = {} } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new RangeError('timeoutMs must be an integer from 1 to 60000 milliseconds');
  }
  const names = ['preflight', 'stopOld', 'clone', 'validate', 'startSafe', 'stopSafe',
    'installPreview', 'startPreview', 'health', 'stopPreview', 'restoreOld', 'startOld'];
  for (const name of names) {
    if (typeof operations?.[name] !== 'function') throw new TypeError(`Missing operation: ${name}`);
  }
  const limits = Object.fromEntries(names.map((name) => [name, 120_000]));
  limits.clone = 600_000;
  limits.validate = 180_000;
  const overrides = Object.create(null);
  let entries;
  if (Array.isArray(timeouts)) {
    entries = timeouts.map((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError('Invalid timeout entry');
      return entry;
    });
  } else if (timeouts !== null && typeof timeouts === 'object' &&
      [Object.prototype, null].includes(Object.getPrototypeOf(timeouts))) {
    entries = Reflect.ownKeys(timeouts).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(timeouts, key);
      if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('Timeout must be a value');
      return [key, descriptor.value];
    });
  } else {
    throw new TypeError('timeouts must be a plain object or entry list');
  }
  for (const [key, value] of entries) {
    if (typeof key !== 'string' || !Object.hasOwn(limits, key)) {
      throw new TypeError('Unknown timeout operation');
    }
    if (Object.hasOwn(overrides, key)) throw new TypeError('Duplicate timeout operation');
    if (!Number.isInteger(value) || value <= 0 || value > limits[key]) {
      throw new RangeError(`Invalid timeout for ${key}`);
    }
    overrides[key] = value;
  }

  const state = { old: 'active', safe: 'stopped', preview: 'stopped', refs: 'old' };
  const history = [];
  let phase = 'preflight';
  let timedOut = false;
  let unconfirmed = false;
  const invoke = async (name) => {
    const controller = new AbortController();
    let timer;
    history.push({ operation: name, status: 'started' });
    try {
      await Promise.race([
        Promise.resolve().then(() => operations[name]({ signal: controller.signal })),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new Error(`Timeout: ${name}`));
          }, overrides[name] ?? timeoutMs);
        }),
      ]);
      history.push({ operation: name, status: 'confirmed' });
    } catch (error) {
      if (!timedOut && error?.code === 'OPERATION_UNCONFIRMED') unconfirmed = true;
      history.push({ operation: name, status: timedOut ? 'timeout' : unconfirmed ? 'unconfirmed' : 'failed' });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  const errorCode = () => timedOut ? 'OPERATION_TIMEOUT' : unconfirmed ? 'OPERATION_UNCONFIRMED' : 'OPERATION_FAILED';
  const result = (status, error = null, rollbackError = null) => ({
    status, phase, state: { ...state }, error, rollbackError, history,
  });

  try {
    await invoke('preflight');
    phase = 'stop-old';
    state.old = 'unknown';
    await invoke('stopOld');
    state.old = 'stopped';
    phase = 'clone+validate';
    await invoke('clone');
    await invoke('validate');
    phase = 'safe-boot';
    state.safe = 'unknown';
    await invoke('startSafe');
    state.safe = 'active';
    phase = 'stop-safe';
    state.safe = 'unknown';
    await invoke('stopSafe');
    state.safe = 'stopped';
    phase = 'install-preview';
    state.refs = 'unknown';
    await invoke('installPreview');
    state.refs = 'preview';
    phase = 'start-preview';
    state.preview = 'unknown';
    await invoke('startPreview');
    state.preview = 'active';
    phase = 'health';
    await invoke('health');
    return result('completed');
  } catch {
    const originalError = errorCode();
    if (timedOut || unconfirmed || state.old === 'unknown' || phase === 'stop-safe') {
      return result('unconfirmed', originalError);
    }
    if (state.old === 'active') return result('unchanged', originalError);
    try {
      if (state.preview !== 'stopped') {
        state.preview = 'unknown';
        await invoke('stopPreview');
        state.preview = 'stopped';
      }
      if (state.safe !== 'stopped') {
        state.safe = 'unknown';
        await invoke('stopSafe');
        state.safe = 'stopped';
      }
      if (state.refs !== 'old') {
        state.refs = 'unknown';
        await invoke('restoreOld');
        state.refs = 'old';
      }
      state.old = 'unknown';
      await invoke('startOld');
      state.old = 'active';
      return result('rolled-back', originalError);
    } catch {
      return result('unconfirmed', originalError, errorCode());
    }
  }
}
