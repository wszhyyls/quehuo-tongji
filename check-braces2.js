const fs = require('fs');
const c = fs.readFileSync('static/js/store.js', 'utf8');

// 用正确的字符串/注释状态机
let i = 0, line = 1, col = 1;
let inString = null;  // ', ", `
let inComment = null; // line, block
let inRegex = false;
let parens = 0, braces = 0, brackets = 0;
const stack = []; // 跟踪嵌套

function push(ch) { stack.push({ ch, line, col }); }
function pop() { return stack.pop(); }

while (i < c.length) {
  const ch = c[i];
  const prev = i > 0 ? c[i-1] : '';
  const next = i < c.length - 1 ? c[i+1] : '';
  if (ch === '\n') { line++; col = 1; i++; continue; }
  col++;

  // 在字符串里
  if (inString) {
    if (ch === '\\' && next) { i += 2; col++; continue; }
    if (ch === inString) inString = null;
    i++; continue;
  }
  // 在注释里
  if (inComment === 'line') { i++; continue; }
  if (inComment === 'block') {
    if (prev === '*' && ch === '/') { inComment = null; }
    i++; continue;
  }
  // 字符串开始
  if (ch === '"' || ch === "'" || ch === '`') {
    inString = ch; i++; continue;
  }
  // 注释开始
  if (ch === '/' && next === '/') { inComment = 'line'; i += 2; col++; continue; }
  if (ch === '/' && next === '*') { inComment = 'block'; i += 2; col++; continue; }
  // 括号计数
  if (ch === '(') { parens++; push('('); }
  else if (ch === ')') {
    parens--;
    if (parens < 0) console.log('Extra ) at line', line, 'col', col);
    pop();
  }
  else if (ch === '{') { braces++; push('{'); }
  else if (ch === '}') { braces--; if (braces < 0) console.log('Extra } at line', line); pop(); }
  else if (ch === '[') { brackets++; push('['); }
  else if (ch === ']') { brackets--; if (brackets < 0) console.log('Extra ] at line', line); pop(); }
  i++;
}
console.log('Final: parens=' + parens + ', braces=' + braces + ', brackets=' + brackets);
console.log('File lines:', line);
console.log('Stack remaining (unclosed):', stack.length);
if (stack.length > 0) console.log('Last unclosed:', stack[stack.length-1]);
