// In-memory test fixture only. It does not manage operating-system services.
const unconfirmed = () => Object.assign(new Error('Service action unconfirmed'), { code: 'OPERATION_UNCONFIRMED' });
const failed = () => new Error('Simulated operation failed');

export function createTestServiceManager({ original = 'original', clone = 'clone', environment = [], faults = {} } = {}) {
  if (typeof original !== 'string' || !original || typeof clone !== 'string' || !clone || original === clone) {
    throw new TypeError('Distinct test data identities are required');
  }
  const services = { old: 'active', safe: 'stopped', preview: 'stopped' };
  const jobs = new Map();
  const calls = [];
  let nextId = 0;
  let refs = 'old';
  let socketOwner = 'old';
  let cloned = false;
  let validated = false;
  let appliedEnvironment = {};

  function assertIdle() {
    if ([...jobs.values()].some(job => job.state === 'pending')) throw unconfirmed();
  }
  function assertStopped(...names) {
    assertIdle();
    if (names.some(name => services[name] !== 'stopped' || socketOwner === name)) throw unconfirmed();
  }
  function submit(name, service, action) {
    assertIdle();
    const fault = faults[name];
    if (fault === 'before') throw failed();
    if (action === 'start') {
      assertStopped('old', 'safe', 'preview');
      if (socketOwner !== null) throw unconfirmed();
      if (service !== 'old' && (!validated || appliedEnvironment.DATA_DIR !== clone || refs !== 'preview' && service === 'preview')) throw failed();
      if (service === 'old' && refs !== 'old') throw failed();
    }
    const id = ++nextId;
    let resolve;
    const completion = new Promise(done => { resolve = done; });
    const job = { id, name, service, action, state: 'pending', resolve };
    jobs.set(id, job);
    services[service] = action === 'start' ? 'activating' : 'deactivating';
    if (!['pending', 'lost', 'stale'].includes(fault)) finish(id, fault === 'job-failed' ? 'failed' : 'done');
    if (fault === 'lost' || fault === 'stale') throw unconfirmed();
    return completion.then(result => {
      if (result !== 'done') throw unconfirmed();
      if (jobs.get(id) !== job || job.state !== 'done') throw unconfirmed();
      if (services[service] !== (action === 'start' ? 'active' : 'stopped')) throw unconfirmed();
    });
  }
  function finish(id, result = 'done') {
    const job = jobs.get(id);
    if (!job || job.state !== 'pending' || !['done', 'failed'].includes(result)) throw new Error('Invalid test job completion');
    job.state = result;
    if (result === 'done') {
      services[job.service] = job.action === 'start' ? 'active' : 'stopped';
      if (job.action === 'start') socketOwner = job.service;
      else if (socketOwner === job.service) socketOwner = null;
    }
    else services[job.service] = 'unknown';
    job.resolve(result);
  }
  function simple(name, fn) {
    calls.push(name);
    assertIdle();
    if (faults[name] === 'before') throw failed();
    fn();
    if (faults[name] === 'after') throw failed();
    if (faults[name] === 'lost') throw unconfirmed();
  }
  function service(name, target, action) {
    calls.push(name);
    return submit(name, target, action);
  }
  const operations = {
    preflight: async () => simple('preflight', () => {
      if (services.old !== 'active') throw failed();
      assertStopped('safe', 'preview');
    }),
    stopOld: async () => service('stopOld', 'old', 'stop'),
    clone: async () => simple('clone', () => { assertStopped('old', 'safe', 'preview'); cloned = true; }),
    validate: async () => simple('validate', () => { assertStopped('old', 'safe', 'preview'); if (!cloned) throw failed(); validated = true; }),
    startSafe: async () => {
      appliedEnvironment = Object.assign({}, ...environment);
      return service('startSafe', 'safe', 'start');
    },
    stopSafe: async () => service('stopSafe', 'safe', 'stop'),
    installPreview: async () => simple('installPreview', () => { assertStopped('old', 'safe', 'preview'); refs = 'preview'; }),
    startPreview: async () => service('startPreview', 'preview', 'start'),
    health: async () => simple('health', () => { if (services.preview !== 'active') throw failed(); }),
    stopPreview: async () => service('stopPreview', 'preview', 'stop'),
    restoreOld: async () => simple('restoreOld', () => { assertStopped('old', 'safe', 'preview'); refs = 'old'; }),
    startOld: async () => service('startOld', 'old', 'start'),
  };
  return {
    operations, finish,
    snapshot: () => ({ services: { ...services }, socketOwner, refs, cloned, validated, environment: { ...appliedEnvironment },
      calls: [...calls], jobs: [...jobs.values()].map(({ id, name, state }) => ({ id, name, state })) }),
  };
}
