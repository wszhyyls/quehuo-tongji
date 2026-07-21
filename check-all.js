const fs = require('fs');
const path = 'static/js/store.js';
const c = fs.readFileSync(path, 'utf8');

// 检查所有括号
const checks = {
  '{': 0, '}': 0,
  '(': 0, ')': 0,
  '[': 0, ']': 0
};
let line = 1, inString = null, inComment = null, inRegex = false;
for (let i = 0; i < c.length; i++) {
  const ch = c[i];
  const prev = i > 0 ? c[i-1] : '';
  if (ch === '\n') { line++; continue; }
  // 处理注释
  if (!inString && !inRegex) {
    if (inComment === 'line' && ch === '\n') { inComment = null; continue; }
    if (inComment === 'block' && prev === '*' && ch === '/') { inComment = null; continue; }
    if (inComment) continue;
    if (prev === '/' && ch === '/') { inComment = 'line'; continue; }
    if (prev === '/' && ch === '*') { inComment = 'block'; continue; }
  }
  // 处理字符串
  if (!inComment && (ch === '"' || ch === "'" || ch === '`')) {
    if (inString === ch && prev !== '\\') { inString = null; continue; }
    if (!inString) { inString = ch; continue; }
  }
  if (inString) continue;
  // 计数括号
  if (checks[ch] !== undefined) checks[ch]++;
}
console.log('Final counts:');
for (const k in checks) console.log('  ' + k + ': ' + checks[k]);
console.log('File: ' + c.length + ' bytes, ' + line + ' lines');
