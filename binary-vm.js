const fs = require('fs');
const vm = require('vm');
const c = fs.readFileSync('static/js/store.js', 'utf8');
const lines = c.split('\n');

// 二分找第一个 SyntaxError
function tryParse(text) {
  try { new vm.Script(text, { filename: 'store.js' }); return null; }
  catch (e) { return e; }
}

let lo = 1, hi = lines.length;
while (lo < hi) {
  const mid = Math.floor((lo + hi + 1) / 2);
  const text = lines.slice(0, mid).join('\n');
  const err = tryParse(text);
  if (!err) {
    lo = mid;
  } else {
    hi = mid - 1;
  }
}
console.log('Last good line:', lo, ':', lines[lo-1]);
console.log('First bad line:', lo+1, ':', lines[lo]);
// 显示错误
const text = lines.slice(0, lo+1).join('\n');
const err = tryParse(text);
if (err) console.log('Error:', err.message);
