const fs = require('fs');
const c = fs.readFileSync('static/js/store.js', 'utf8');
const lines = c.split('\n');
const l = lines[623];
let p = 0, b = 0, k = 0;
let inString = null, inComment = null;
for (let i = 0; i < l.length; i++) {
  const ch = l[i];
  const prev = i > 0 ? l[i-1] : '';
  if (inComment === 'line') continue;
  if (inComment === 'block') {
    if (prev === '*' && ch === '/') inComment = null;
    continue;
  }
  if (inString) {
    if (ch === '\\' && i < l.length - 1) { i++; continue; }
    if (ch === inString) inString = null;
    continue;
  }
  if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
  if (prev === '/' && ch === '/') { inComment = 'line'; continue; }
  if (prev === '/' && ch === '*') { inComment = 'block'; continue; }
  if (ch === '(') p++;
  else if (ch === ')') p--;
  else if (ch === '{') b++;
  else if (ch === '}') b--;
  else if (ch === '[') k++;
  else if (ch === ']') k--;
}
console.log('Line 624 final: parens=' + p + ' braces=' + b + ' brackets=' + k);
console.log('Likely issue:');
if (p > 0) console.log('  Missing ' + p + ' closing )');
if (b > 0) console.log('  Missing ' + b + ' closing }');
if (k > 0) console.log('  Missing ' + k + ' closing ]');
if (p < 0) console.log('  Extra ' + (-p) + ' )');
if (b < 0) console.log('  Extra ' + (-b) + ' }');
if (k < 0) console.log('  Extra ' + (-k) + ' ]');
