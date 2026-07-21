const fs = require('fs');
const vm = require('vm');
const c = fs.readFileSync('static/js/store.js', 'utf8');
const lines = c.split('\n');

// 尝试解析每一行（添加每一行后看是否还能解析）
// 关键：找"加了某行后开始报 SyntaxError"的位置
let lastGood = 0;
for (let i = 1; i <= lines.length; i++) {
  const text = lines.slice(0, i).join('\n');
  try {
    new vm.Script(text, { filename: 'store.js' });
    lastGood = i;
  } catch (e) {
    if (e.message.includes('Unexpected end of input') || e.message.includes('Unexpected token')) {
      // 找到第一个 bad 行
      console.log('Line ' + i + ' makes it fail:');
      console.log('  Line content: ' + lines[i-1].substring(0, 100));
      console.log('  Error: ' + e.message);
      // 显示上下文
      for (let j = Math.max(0, i-3); j < i; j++) {
        console.log('  ' + (j+1) + ': ' + lines[j].substring(0, 90));
      }
      break;
    }
  }
}
console.log('Last good line: ' + lastGood);
