const fs = require('fs');
try {
  new Function(fs.readFileSync('static/js/store.js', 'utf8'));
  console.log('OK - no error');
} catch (e) {
  console.log('ERROR:', e.message);
  console.log('Stack first line:', (e.stack || '').split('\n')[1] || '');
}
