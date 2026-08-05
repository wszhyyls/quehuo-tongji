import fs from 'fs';
const c = fs.readFileSync('g:/Trae项目/缺货统计系统/static/js/admin.js', 'utf8');
const lines = c.split('\n');
for (let i = 0; i < lines.length; i++) {
  // 检查字符串中的正则相关模式
  if (lines[i].includes('new RegExp') || lines[i].match(/\/[gimsu]+\s*[),;]/)) {
    console.log('Line ' + (i+1) + ': ' + lines[i].trim().substring(0, 150));
  }
}
console.log('Done - ' + lines.length + ' lines checked');

// 再检查 safeHtml 函数中的 regex
const safeIdx = c.indexOf('function safeHtml');
if (safeIdx >= 0) {
  const safeEnd = c.indexOf('function ', safeIdx + 5);
  const safeCode = safeEnd >= 0 ? c.substring(safeIdx, safeEnd) : c.substring(safeIdx);
  console.log('=== safeHtml function ===');
  console.log(safeCode.substring(0, 800));
}
