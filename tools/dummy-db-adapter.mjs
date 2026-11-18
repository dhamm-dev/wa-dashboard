const properties = Object.freeze([
  'Id', 'Names', 'LoadState', 'Transient', 'ExecStart', 'RuntimeMaxUSec',
  'StandardInput', 'Wants', 'Requires', 'Requisite', 'BindsTo', 'PartOf',
  'ActiveState', 'SubState', 'MainPID', 'ControlPID', 'ControlGroup', 'Job',
  'InvocationID',
]);
const propertySet = new Set(properties);
const unitPattern = /^dhexbot-db-test-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.service$/;
const fail = () => Object.assign(new Error('Dummy DB operation unconfirmed'), { code: 'OPERATION_UNCONFIRMED' });

export function parseDummyDbShow(output) {
  try {
    if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > 16384 ||
        output.includes('\0') || output.includes('\r')) throw fail();
    const result = Object.create(null);
    const lines = output.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length !== properties.length) throw fail();
    for (const line of lines) {
      const separator = line.indexOf('=');
      if (separator <= 0) throw fail();
      const name = line.slice(0, separator);
      if (!propertySet.has(name) || Object.hasOwn(result, name)) throw fail();
      result[name] = line.slice(separator + 1);
    }
    if (!unitPattern.test(result.Id) || result.Names !== result.Id) throw fail();
    return Object.freeze(result);
  } catch {
    throw fail();
  }
}
