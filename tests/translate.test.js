const { test } = require('node:test');
const assert = require('node:assert');

const { likelyEnglish } = require('../src/translate');

test('likelyEnglish treats English sentences as English', () => {
  assert.equal(likelyEnglish('How do I download the Windows build?'), true);
  assert.equal(likelyEnglish('Thanks for the help with this'), true);
});

test('likelyEnglish flags other languages', () => {
  assert.equal(likelyEnglish('Bonjour, comment télécharger la dernière version ?'), false);
  assert.equal(likelyEnglish('Wie kann ich das Programm herunterladen?'), false);
  assert.equal(likelyEnglish('最新バージョンはどこでダウンロードできますか'), false);
});

test('likelyEnglish leaves very short messages alone', () => {
  assert.equal(likelyEnglish('salut'), true);
  assert.equal(likelyEnglish('ok thanks'), true);
  assert.equal(likelyEnglish(''), true);
});
