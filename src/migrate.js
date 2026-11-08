// One-time data migrations, run on boot. Idempotent: a value already fixed is left alone,
// so this is safe even on a store that has already been migrated by a previous version.
const store = require('./storage');

function migrate() {
  let changed = false;

  // /setup can pin a channel id in the store; those two dev channels were deleted and
  // re-created with new ids. The .env values are the same ids, so this only matters if
  // /setup ever overwrote them with the old ones.
  const settings = store.data.settings ??= {};
  if (settings.aiChannelId === '1566503029916700752') {
    settings.aiChannelId = '1568689660245450993'; // old AI channel -> new AI channel
    changed = true;
  }
  if (settings.botRepoChannelId === '1567292394116751390') {
    settings.botRepoChannelId = '1568689855284777144'; // old bot changelog -> new bot changelog
    changed = true;
  }

  // The activity-logs channel was re-created too (the old id is dead, the new one is
  // 1568689891812970536). /setup logs writes this per guild.
  for (const guild of Object.values(store.data.guilds)) {
    if (guild?.logChannelId === '1566727584388223076') {
      guild.logChannelId = '1568689891812970536';
      changed = true;
    }
  }

  // Tickets opened before inactivity tracking have no lastActivity. Give them a fresh 48-hour
  // window from this boot instead of closing them immediately because createdAt is old.
  for (const guild of Object.values(store.data.guilds)) {
    for (const ticket of Object.values(guild?.tickets ?? {})) {
      if (ticket && ticket.lastActivity == null) {
        ticket.lastActivity = Date.now();
        changed = true;
      }
    }
  }

  // botRepo.lastSha advanced to dc31ea0 while the changelog channel was still the dead one,
  // so the commits after ddbf8ce never reached any channel. Rewind the cursor to the last
  // commit that was actually posted; the normal tick reposts the whole gap and
  // alreadyPosted() keeps a restart from duplicating it. announced === delivered, so the
  // replay path stays off.
  const botRepo = settings.botRepo;
  if (botRepo?.lastSha === 'dc31ea044373f7396789683c9020d99829f6bdb8') {
    botRepo.lastSha = 'ddbf8ceb02b61f767e945d1a59c62addae476fe5';
    changed = true;
  }

  if (changed) store.save();
  return changed;
}

module.exports = { migrate };
