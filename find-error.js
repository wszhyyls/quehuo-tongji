const fs = require('fs');
const c = fs.readFileSync('static/js/store.js', 'utf8');

// 用 V8 的 sourceTextModule 解析
try {
  // 直接 require 会执行
  // 用 vm.Script 编译但不执行
  const vm = require('vm');
  const script = new vm.Script(c, { filename: 'store.js' });
  console.log('OK - file is valid JavaScript');
} catch (e) {
  console.log('ERROR:', e.message);
  console.log('Stack:');
  console.log((e.stack || '').split('\n').slice(0, 5).join('\n'));
}
