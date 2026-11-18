const commands = ['menu', 'help', 'ping', 'resetai', 'info', 'token', 'status'];
const adminCommands = new Set(['token', 'status']);

function parseJid(value) {
  if (typeof value !== 'string') return null;
  const match = /^([1-9]\d{5,19})(?::\d+)?@s\.whatsapp\.net$/.exec(value);
  if (match) return { kind: 'pn', local: match[1], jid: `${match[1]}@s.whatsapp.net` };
  const lid = /^(\d{1,20})(?::\d+)?@lid$/.exec(value);
  if (lid) return { kind: 'lid', local: lid[1], jid: `${lid[1]}@lid` };
  return null;
}

const ignore = reason => ({ type: 'ignore', reason });

export function parseBotMessage(upsert, message, options = {}) {
  if (upsert?.type !== 'notify') return ignore('not-live-event');
  const key = message?.key;
  if (!key || key.fromMe !== false || typeof key.id !== 'string' || !key.id) return ignore('invalid-key');
  if (message.messageStubType != null || message.messageStubParameters?.length || message.broadcast === true ||
      message.isHistorySync === true || message.edited === true || message.isEdit === true) return ignore('system-or-edit');

  let timestamp = message.messageTimestamp;
  try {
    if (timestamp && typeof timestamp.toNumber === 'function') timestamp = timestamp.toNumber();
  } catch {
    return ignore('invalid-time');
  }
  const { nowMs, maxAgeMs } = options;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0 ||
      !Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return ignore('invalid-time');
  const sentMs = timestamp * 1000;
  if (!Number.isFinite(sentMs) || sentMs > nowMs || nowMs - sentMs > maxAgeMs) return ignore('outside-time-window');

  const bots = [parseJid(options.socketUser?.id), parseJid(options.socketUser?.lid)].filter(Boolean);
  if (!bots.length) return ignore('missing-bot-identity');
  const remote = key.remoteJid;
  const isGroup = typeof remote === 'string' && /^\d{1,20}(?:-\d{1,20})?@g\.us$/.test(remote);
  const sender = parseJid(isGroup ? key.participant : remote);
  if (!sender) return ignore('invalid-sender');
  if (bots.some(bot => bot.jid === sender.jid)) return ignore('self');

  const content = message.message;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return ignore('unsupported-message');
  const keys = Object.keys(content).filter(name => content[name] != null);
  if (keys.length !== 1) return ignore('unsupported-message');
  let text;
  if (keys[0] === 'conversation' && typeof content.conversation === 'string') text = content.conversation;
  else if (keys[0] === 'extendedTextMessage' && typeof content.extendedTextMessage?.text === 'string') text = content.extendedTextMessage.text;
  else return ignore('unsupported-message');

  if (isGroup) {
    const mentions = content.extendedTextMessage?.contextInfo?.mentionedJid;
    if (!Array.isArray(mentions)) return ignore('not-mentioned');
    const targets = bots.filter(bot => mentions.some(value => parseJid(value)?.jid === bot.jid));
    if (!targets.length) return ignore('not-mentioned');
    const token = /^\s*@([0-9]+)(?=\s|$)/u.exec(text);
    if (!token || !targets.some(bot => bot.local === token[1])) return ignore('ambiguous-mention-text');
    const remaining = text.slice(token[0].length);
    if (new RegExp(`(?:^|\\s)@${token[1]}(?=\\s|$)`, 'u').test(remaining)) return ignore('ambiguous-mention-text');
    text = remaining;
  }
  text = text.trim();
  if (!text) return ignore('empty-text');

  const admins = Array.isArray(options.adminJids) ? options.adminJids.map(parseJid).filter(value => value?.kind === 'pn') : [];
  const isAdmin = sender.kind === 'pn' && admins.some(value => value.jid === sender.jid);
  const enabled = Array.isArray(options.enabledCommands) ? new Set(options.enabledCommands.filter(value => commands.includes(value))) : new Set(commands);
  const context = {
    chatJid: remote,
    senderJid: sender.jid,
    isAdmin,
    uncertainty: isGroup ? ['duplicate-delivery', 'mention-text-offset'] : ['duplicate-delivery'],
    ...(sender.kind === 'lid' ? { identityUncertain: true } : {})
  };
  if (!text.startsWith('.')) return { type: 'generate', text, ...context };
  const match = /^\.([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
  const command = match?.[1].toLowerCase() ?? '';
  if (!commands.includes(command)) return { type: 'unknown-command', command, ...context };
  if (adminCommands.has(command) && !isAdmin) return { type: 'denied', command, ...context };
  if (!enabled.has(command)) return { type: 'disabled', command, ...context };
  const decision = { type: 'command', command, args: match[2] ?? '', ...context };
  if (command === 'menu') decision.menu = {
    title: 'DHEXX MENUS',
    commands: commands.filter(name => enabled.has(name) && (isAdmin || !adminCommands.has(name))).map(name => `.${name}`)
  };
  return decision;
}
