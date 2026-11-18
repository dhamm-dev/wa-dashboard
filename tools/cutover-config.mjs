const release = '/home/dhexweb/dhexbot-preview-release-37ec9a3cc5828208';
const oldApp = '/home/dhexweb/wa-dashboard';
const previewEnv = '/home/dhexweb/dhexbot-preview-release-05aee121be1701ab/config/preview.env';

function environment(dataDir) {
  return `DATA_DIR=${dataDir}\nHOST=127.0.0.1\nPORT=3000\n`;
}

function dropin(app, overlay) {
  return `[Service]\nWorkingDirectory=${app}\nExecStart=\nExecStart=/usr/bin/node ${app}/src/server.js\nEnvironmentFile=\nEnvironmentFile=${oldApp}/.env\n${overlay}UnsetEnvironment=DHEXBOT_SAFE_BOOT\n`;
}

export function createCutoverConfig(cloneId) {
  if (typeof cloneId !== 'string' || !/^[0-9a-f]{32}$/.test(cloneId)) {
    throw new TypeError('Invalid clone identifier');
  }
  const clone = `${release}/data-${cloneId}`;
  const cutoverEnv = `${release}/cutover-${cloneId}.env`;
  const rollbackEnv = `${release}/rollback-${cloneId}.env`;
  return Object.freeze({
    clone,
    cutoverEnv,
    rollbackEnv,
    previewEnvironment: environment(clone),
    rollbackEnvironment: environment(`${oldApp}/data`),
    previewDropin: dropin(`${release}/app`, `EnvironmentFile=${previewEnv}\nEnvironmentFile=${cutoverEnv}\n`),
    rollbackDropin: dropin(oldApp, `EnvironmentFile=${rollbackEnv}\n`),
  });
}
