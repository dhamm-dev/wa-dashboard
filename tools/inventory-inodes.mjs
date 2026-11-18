const invalid = () => new Error('Invalid inventory');
const decimal = value => {
  if (typeof value !== 'string' || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value) || /[^0-9]/.test(value)) throw invalid();
  const result = BigInt(value);
  if (result > 0xffffffffffffffffn) throw invalid();
  return result;
};

export function inventoryInodes(manifest) {
  if (!Array.isArray(manifest) || manifest.length === 0) throw invalid();
  const result = [];
  const seen = new Set();
  for (const entry of manifest) {
    if (!entry || typeof entry !== 'object') throw invalid();
    const dev = decimal(entry.device);
    const ino = decimal(entry.inode);
    const key = `${dev}:${ino}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push({ dev, ino });
    }
  }
  return result;
}
