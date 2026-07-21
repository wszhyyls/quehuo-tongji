const fs = require('fs');
const parser = require('@babel/parser');
const c = fs.readFileSync('static/js/store.js', 'utf8');

// 逐行添加找第一个让 babel 报错的行
const lines = c.split('\n');
let lastGood = 0;
for (let i = 1; i <= lines.length; i++) {
  const text = lines.slice(0, i).join('\n');
  try {
    parser.parse(text, { sourceType: 'script' });
    lastGood = i;
  } catch (e) {
    if (e.message === 'Unexpected token (1064:0)') {
      // 找到问题了
      console.log('Line ' + i + ' makes full parse fail with: ' + e.message);
      console.log('  Last good line: ' + lastGood);
      // 显示 line lastGood 到 i
      for (let j = Math.max(0, lastGood - 1); j <= i && j < lines.length; j++) {
        console.log('  ' + (j+1) + ': ' + (lines[j] || '').substring(0, 100));
      }
      break;
    }
  }
}
