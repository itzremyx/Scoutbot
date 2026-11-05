const fs = require('fs');
const path = require('path');

const EVERY_MS = 8 * 60 * 60 * 1000;
const KEEP = 21;
const dir = path.join(__dirname, '..', 'data', 'backups');
const source = path.join(__dirname, '..', 'data', 'store.json');

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function backupStore() {
  if (!fs.existsSync(source)) return null;
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'store-' + stamp() + '.json');
  fs.copyFileSync(source, target);
  const old = fs.readdirSync(dir)
    .filter((name) => name.startsWith('store-') && name.endsWith('.json'))
    .sort();
  for (const name of old.slice(0, Math.max(0, old.length - KEEP))) {
    fs.unlinkSync(path.join(dir, name));
  }
  return target;
}

function register() {
  const run = () => {
    try {
      const file = backupStore();
      if (file) console.log('Store backup written: ' + path.basename(file));
    } catch (err) {
      console.error('Store backup failed:', err.message);
    }
  };
  run();
  const timer = setInterval(run, EVERY_MS);
  if (timer.unref) timer.unref();
}

module.exports = { register, backupStore, EVERY_MS, KEEP };
