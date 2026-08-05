import fs from 'fs';
try {
  new Function(fs.readFileSync('g:/Trae项目/缺货统计系统/static/js/admin.js','utf8'));
  console.log('No syntax error in admin.js');
} catch(e) {
  console.log('admin.js syntax error:', e.message);
}

try {
  new Function(fs.readFileSync('g:/Trae项目/缺货统计系统/static/js/utils.js','utf8'));
  console.log('No syntax error in utils.js');
} catch(e) {
  console.log('utils.js syntax error:', e.message);
}
