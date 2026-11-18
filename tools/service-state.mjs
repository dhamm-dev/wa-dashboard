const identity = value => typeof value === 'string' && value.length > 0 && value.trim() === value;

function common(snapshot) {
  return snapshot !== null && typeof snapshot === 'object' &&
    identity(snapshot.bootId) && identity(snapshot.managerId) &&
    identity(snapshot.unitId) &&
    identity(snapshot.generation) && identity(snapshot.gateId) &&
    snapshot.gateHeld === true && snapshot.writerCensusComplete === true &&
    snapshot.externalWriters === 0 && snapshot.job === null &&
    snapshot.restartState === 'none' && identity(snapshot.dataDirId) &&
    identity(snapshot.expectedDataDirId) && snapshot.dataDirId === snapshot.expectedDataDirId;
}

function stable(first, second) {
  return ['bootId', 'managerId', 'unitId', 'invocationId', 'generation', 'gateId',
    'dataDirId', 'expectedDataDirId'].every(key => first[key] === second[key]);
}

function quiescent(snapshot) {
  return common(snapshot) && identity(snapshot.priorInvocationId) &&
    (snapshot.invocationId === '' || snapshot.invocationId === snapshot.priorInvocationId) &&
    snapshot.activeState === 'inactive' && snapshot.subState === 'dead' &&
    snapshot.mainPID === 0 && snapshot.controlPID === 0 && snapshot.unitWriters === 0 &&
    snapshot.cgroupCollectorTrusted === true &&
    (snapshot.cgroupState === 'empty' || snapshot.cgroupState === 'absent');
}

export function isQuiescent(first, second) {
  try {
    return quiescent(first) && quiescent(second) && stable(first, second) &&
      first.priorInvocationId === second.priorInvocationId;
  } catch {
    return false;
  }
}

function healthy(snapshot) {
  return common(snapshot) && identity(snapshot.invocationId) && snapshot.activeState === 'active' && snapshot.subState === 'running' &&
    Number.isSafeInteger(snapshot.mainPID) && snapshot.mainPID > 0 && snapshot.controlPID === 0 &&
    snapshot.unitWriters === 1 && snapshot.healthOk === true &&
    identity(snapshot.appId) && identity(snapshot.expectedAppId) && snapshot.appId === snapshot.expectedAppId &&
    identity(snapshot.cloneId) && identity(snapshot.expectedCloneId) && snapshot.cloneId === snapshot.expectedCloneId &&
    snapshot.dataDirId === snapshot.cloneId;
}

export function isHealthyPreview(first, second) {
  try {
    return healthy(first) && healthy(second) && stable(first, second) &&
      ['mainPID', 'appId', 'expectedAppId', 'cloneId', 'expectedCloneId']
        .every(key => first[key] === second[key]);
  } catch {
    return false;
  }
}
