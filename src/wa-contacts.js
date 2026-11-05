const validJid = jid => typeof jid === 'string' && /^[1-9]\d{5,19}@s\.whatsapp\.net$/.test(jid);

export function createContactStore() {
  const contacts = new Map();
  function update(items) {
    if (!Array.isArray(items)) return;
    for (const contact of items) {
      if (!contact || typeof contact !== 'object') continue;
      const jid = validJid(contact.id) ? contact.id : validJid(contact.phoneNumber) ? contact.phoneNumber : null;
      if (!jid) continue;
      const previous = contacts.get(jid) || {};
      const name = [contact.name, contact.notify, contact.verifiedName, previous.name, jid.split('@')[0]].find(v => typeof v === 'string' && v.trim());
      contacts.delete(jid);
      contacts.set(jid, { jid, name: name.trim().slice(0, 100) });
      if (contacts.size > 10000) contacts.delete(contacts.keys().next().value);
    }
  }
  return { update, list: () => [...contacts.values()] };
}

export function bindContactEvents(events, store, isCurrent) {
  const update = items => { if (isCurrent()) store.update(items); };
  events.on('messaging-history.set', data => update(data.contacts));
  events.on('contacts.upsert', update);
  events.on('contacts.update', update);
}
