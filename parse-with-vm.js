const fs = require('fs');
const vm = require('vm');
const c = fs.readFileSync('static/js/store.js', 'utf8');

// 分块解析找错误位置
const chunkSize = 50;
for (let start = 0; start < c.length; start += chunkSize) {
  const end = Math.min(start + chunkSize, c.length);
  const chunk = c.substring(0, end);
  try {
    new vm.Script(chunk, { filename: 'store.js' });
  } catch (e) {
    console.log('First error at offset', end, ':', e.message);
    // 显示错误附近 100 字符
    const errStart = Math.max(0, end - 100);
    console.log('Context: ...' + c.substring(errStart, end) + '...');
    break;
  }
}
console.log('Done');
