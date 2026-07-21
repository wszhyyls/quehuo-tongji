// 逐行尝试解析
const fs = require('fs');
const c = fs.readFileSync('static/js/store.js', 'utf8');
const lines = c.split('\n');

// 找到具体哪一行有语法问题
for (let i = 0; i < lines.length; i++) {
  const partial = lines.slice(0, i + 1).join('\n');
  try {
    new Function(partial);
  } catch (e) {
    if (e.message.includes('Unexpected') || e.message.includes('Unexpected')) {
      console.log('Line ' + (i + 1) + ': ' + lines[i].substring(0, 100));
      console.log('  Error: ' + e.message);
    }
  }
}
console.log('Done scanning');
