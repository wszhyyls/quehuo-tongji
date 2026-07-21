const fs = require('fs');
const acorn = require('acorn');
const c = fs.readFileSync('static/js/store.js', 'utf8');
const lines = c.split('\n');
const l = lines[623];
console.log('Line 624 length:', l.length);
// 用 try-catch 看错误
try {
  acorn.parse(l, { ecmaVersion: 2020 });
} catch (e) {
  console.log('Error pos:', e.pos);
  console.log('Around pos (pos-30 to pos+30):', JSON.stringify(l.substring(Math.max(0, e.pos-30), e.pos+30)));
  console.log('Char at pos-1:', JSON.stringify(l.substring(e.pos-1, e.pos)));
  console.log('Char at pos:', JSON.stringify(l.substring(e.pos, e.pos+1)));
  console.log('Error message:', e.message);
  // 看 624 行内 pos 之前的引号状态
  let sq = 0, dq = 0, bt = 0;
  for (let i = 0; i < e.pos; i++) {
    const ch = l[i];
    if (ch === "'" && l[i-1] !== '\\') sq++;
    else if (ch === '"' && l[i-1] !== '\\') dq++;
    else if (ch === '`' && l[i-1] !== '\\') bt++;
  }
  console.log('Quotes before pos: sq=' + sq + ' dq=' + dq + ' bt=' + bt);
}
