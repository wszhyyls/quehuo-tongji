const fs = require('fs');
const acorn = require('acorn');
const c = fs.readFileSync('static/js/store.js', 'utf8');
const lines = c.split('\n');
const l = lines[623];

// 把 624 行按字符逐个添加，看哪一步让 acorn 报错
for (let i = 1; i <= l.length; i++) {
  const partial = l.substring(0, i);
  try {
    acorn.parse(partial, { ecmaVersion: 2020 });
  } catch (e) {
    console.log('Add ' + i + ' chars makes it fail:');
    console.log('  Error:', e.message);
    console.log('  Last 30 chars:', JSON.stringify(l.substring(Math.max(0, i-30), i)));
    // 找到具体错位置
    if (e.pos) {
      const p = e.pos;
      console.log('  Around error pos:', JSON.stringify(partial.substring(Math.max(0, p-30), p+30)));
      console.log('  Char at error:', JSON.stringify(partial.substring(p, p+1)));
    }
    break;
  }
}
console.log('Done');
