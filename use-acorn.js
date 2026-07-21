const fs = require('fs');
const acorn = require('acorn');
const c = fs.readFileSync('static/js/store.js', 'utf8');
try {
  acorn.parse(c, { ecmaVersion: 2020, sourceType: 'script', allowHashBang: true });
  console.log('OK - acorn says file is valid');
} catch (e) {
  console.log('ACORN ERROR:');
  console.log('  Message:', e.message);
  console.log('  Line:', e.loc && e.loc.line);
  console.log('  Column:', e.loc && e.loc.column);
  console.log('  Pos:', e.pos);
  // 显示错误附近的内容
  if (e.pos) {
    const start = Math.max(0, e.pos - 100);
    const end = Math.min(c.length, e.pos + 100);
    console.log('  Context: ...' + c.substring(start, end) + '...');
  }
}
