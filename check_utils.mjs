import fs from 'fs';
const c = fs.readFileSync('g:/Trae项目/缺货统计系统/utils_deloy.mjs', 'utf8');
const lines = c.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('new RegExp(')) {
    console.log('L' + (i+1) + ': ' + lines[i].trim().substring(0, 200));
  }
}
console.log('Total lines: ' + lines.length);
var l101 = lines[100] || '(line 101 not found)';
console.log('Line 101: ' + l101.substring(0, 200));
