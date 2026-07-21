const fs = require('fs');
const c = fs.readFileSync('static/js/store.js', 'utf8');
let inString = null, inComment = null, line = 1;
let blockStarts = [], blockEnds = [];

for (let i = 0; i < c.length; i++) {
  const ch = c[i];
  const prev = i > 0 ? c[i-1] : '';
  const next = i < c.length - 1 ? c[i+1] : '';
  if (ch === '\n') { line++; continue; }

  // 处理字符串
  if (!inComment) {
    if (inString === ch && prev !== '\\') { inString = null; continue; }
    if (inString) continue;
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
  }
  // 处理注释
  if (!inString) {
    if (inComment === 'line' && ch === '\n') { inComment = null; continue; }
    if (inComment === 'block' && prev === '*' && ch === '/') { inComment = null; blockEnds.push(line); continue; }
    if (inComment) continue;
    if (prev === '/' && ch === '/') { inComment = 'line'; continue; }
    if (prev === '/' && ch === '*') { inComment = 'block'; blockStarts.push(line); continue; }
  }
}
console.log('Block comment starts:', blockStarts.length, blockStarts);
console.log('Block comment ends:', blockEnds.length, blockEnds);
console.log('File lines:', line);
