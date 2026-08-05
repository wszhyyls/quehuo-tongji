import fs from 'fs';
const c = fs.readFileSync('g:/Trae项目/缺货统计系统/admin_deploy.js', 'utf8');
const lines = c.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('new RegExp(')) {
    console.log('L' + (i+1) + ': ' + lines[i].trim().substring(0, 200));
  }
}
console.log('Total lines: ' + lines.length);
