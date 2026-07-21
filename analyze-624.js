const fs = require('fs');
const c = fs.readFileSync('static/js/store.js', 'utf8');
const lines = c.split('\n');
const l = lines[623];

// 用一个简易的 tokenizer 风格的 parser 来分析
let p = 0, b = 0, k = 0;
let inSingle = false, inDouble = false, inTmpl = false;
let inLineComment = false, inBlockComment = false;
let i = 0;

while (i < l.length) {
  const ch = l[i];
  const next = i < l.length - 1 ? l[i+1] : '';
  const prev = i > 0 ? l[i-1] : '';

  // 行注释
  if (!inSingle && !inDouble && !inTmpl && !inBlockComment && prev === '/' && ch === '/') {
    inLineComment = true;
    i++;
    continue;
  }
  if (inLineComment) { i++; if (ch === '\n') inLineComment = false; continue; }

  // 块注释
  if (!inSingle && !inDouble && !inTmpl && !inLineComment && prev === '/' && ch === '*') {
    inBlockComment = true;
    i++;
    continue;
  }
  if (inBlockComment) {
    if (prev === '*' && ch === '/') inBlockComment = false;
    i++;
    continue;
  }

  // 字符串
  if (!inLineComment && !inBlockComment) {
    if (!inDouble && !inTmpl && ch === "'" && prev !== '\\') {
      inSingle = !inSingle; i++; continue;
    }
    if (!inSingle && !inTmpl && ch === '"' && prev !== '\\') {
      inDouble = !inDouble; i++; continue;
    }
    if (!inSingle && !inDouble && ch === '`' && prev !== '\\') {
      inTmpl = !inTmpl; i++; continue;
    }
  }

  if (inSingle || inDouble || inTmpl) { i++; continue; }

  // 计数括号
  if (ch === '(') p++;
  else if (ch === ')') p--;
  else if (ch === '{') b++;
  else if (ch === '}') b--;
  else if (ch === '[') k++;
  else if (ch === ']') k--;
  i++;
}
console.log('Line 624 final: parens=' + p + ' braces=' + b + ' brackets=' + k);
console.log('In string at end: inSingle=' + inSingle + ' inDouble=' + inDouble + ' inTmpl=' + inTmpl);
console.log('In comment at end: line=' + inLineComment + ' block=' + inBlockComment);
