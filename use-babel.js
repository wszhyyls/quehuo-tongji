const fs = require('fs');
const parser = require('@babel/parser');
const c = fs.readFileSync('static/js/store.js', 'utf8');
try {
  parser.parse(c, { sourceType: 'script' });
  console.log('OK - babel says valid');
} catch (e) {
  console.log('BABEL ERROR:');
  console.log('  Message:', e.message);
  console.log('  Loc:', e.loc);
  console.log('  Pos:', e.pos);
  if (e.pos) {
    const start = Math.max(0, e.pos - 50);
    const end = Math.min(c.length, e.pos + 50);
    console.log('  Context: ...' + JSON.stringify(c.substring(start, end)) + '...');
  }
}
