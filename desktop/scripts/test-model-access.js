const fs = require('fs');
const vm = require('vm');
(async () => {
  const src = fs.readFileSync('main.js', 'utf8');
  const start = src.indexOf('// ---------- Deteksi model yang diizinkan paket API key ----------');
  const end = src.indexOf('function blockedModelIds');
  const snippet = src.slice(start, end);
  const ctx = { readSettings: () => ({}), ipcMain: { handle: () => {}, on: () => {} } };
  vm.createContext(ctx);
  vm.runInContext(snippet, ctx).then;
  console.log('detectPackageFromModels tests:');
  console.log('  PAYG (tanpa mimo/MiniMax):', JSON.stringify(ctx.detectPackageFromModels([{id:'google/gemini-2.5-flash'}])));
  console.log('  Hemat (mimo-v2.5):', JSON.stringify(ctx.detectPackageFromModels([{id:'mimo-v2.5'}])));
  console.log('  MiniMax (MiniMax-M3):', JSON.stringify(ctx.detectPackageFromModels([{id:'MiniMax-M3'}])));
  console.log('  detectModelAccess() :', JSON.stringify(await ctx.detectModelAccess()));
})();
