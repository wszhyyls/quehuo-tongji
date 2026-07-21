// 用 V8 parser 精确定位
const fs = require('fs');
const v8 = require('v8');
v8.setFlagsFromString('--allow-natives-syntax');

// 直接尝试解析文件
try {
  new Function(fs.readFileSync('static/js/store.js', 'utf8'));
  console.log('OK - file is syntactically valid');
} catch (e) {
  console.log('SYNTAX ERROR:');
  console.log('  Message:', e.message);
  console.log('  Stack:', e.stack.split('\n').slice(0, 5).join('\n'));
}
