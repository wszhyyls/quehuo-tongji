const fs = require('fs');
const path = 'static/js/store.js';
const c = fs.readFileSync(path, 'utf8');
let depth = 0, line = 1, lastDepth = 0, lastLine = 0;
for (let i = 0; i < c.length; i++) {
  const ch = c[i];
  if (ch === '\n') { line++; continue; }
  if (ch === '{') depth++;
  else if (ch === '}') { depth--; if (depth < 0) { console.log('Extra } at line', line); process.exit(1); } }
  if (depth !== lastDepth) { console.log('Depth change at line', line, ':', lastDepth, '->', depth); lastDepth = depth; lastLine = line; }
}
console.log('Final depth:', depth, 'at line', line);
console.log('File size:', c.length, 'bytes, total lines:', line);
