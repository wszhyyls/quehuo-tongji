const fs = require('fs');
const c = fs.readFileSync('static/js/store.js', 'utf8');
const lines = c.split('\n');

// 二分搜索找第一个有语法错误的行
let lo = 0, hi = lines.length;
while (lo < hi) {
  const mid = Math.floor((lo + hi + 1) / 2);
  const partial = lines.slice(0, mid).join('\n');
  try {
    new Function(partial);
    lo = mid;
  } catch (e) {
    if (e.message.includes('localStorage') || e.message.includes('is not defined')) {
      // runtime error - 找到这条之前还没问题的位置
      hi = mid - 1;
    } else {
      hi = mid - 1;
    }
  }
}
console.log('Last good line:', lo, '-', lines[lo-1]);
console.log('First bad line:', lo+1, '-', lines[lo]);
