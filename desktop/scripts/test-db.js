/* Smoke test driver db.js tanpa electron: SQLite end-to-end + error handling tipe lain. */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db');

(async () => {
  const tmp = path.join(os.tmpdir(), 'sahabat-db-test-' + Date.now() + '.db');
  fs.writeFileSync(tmp, Buffer.alloc(0));

  const session = await db.createSession({ kind: 'sqlite', filePath: tmp });
  console.log('1. sqlite connect OK');

  console.log('2. init schema:', JSON.stringify(await db.runQuery(session, 'main', 'CREATE TABLE users (id INTEGER PRIMARY KEY, nama TEXT, aktif INTEGER)')));
  console.log('3. insert:', JSON.stringify(await db.runQuery(session, 'main', "INSERT INTO users (nama, aktif) VALUES ('Andi', 1), ('Budi', 0), ('Citra', 1)")));
  console.log('4. select:', JSON.stringify(await db.runQuery(session, 'main', 'SELECT * FROM users ORDER BY id')));
  console.log('5. listDatabases:', JSON.stringify(await db.listDatabases(session)));
  console.log('6. listTables:', JSON.stringify(await db.listTables(session, 'main')));
  console.log('7. quote:', db.quoteIdent('mysql', 'a`b'), db.quoteIdent('postgres', 'a"b'), db.quoteIdent('sqlserver', 'a]b'));
  console.log('8. shellSplit:', JSON.stringify(db.shellSplit('HGETALL "my key" \'other key\' plain')));

  await db.closeSession(session);

  // Error handling untuk server yang tidak hidup
  for (const kind of ['mysql', 'postgres', 'mongodb', 'redis', 'elasticsearch', 'sqlserver']) {
    try {
      await db.createSession({ kind, host: '127.0.0.1', port: 1, user: 'x', password: 'x' });
      console.log(kind, '=> UNEXPECTED OK');
    } catch (err) {
      console.log(kind, '=> error OK:', String(err.message).slice(0, 80));
    }
  }

  fs.unlinkSync(tmp);
  console.log('DONE');
})().catch((err) => { console.error('FATAL', err); process.exit(1); });
