const fs = require('fs');
const esprima = require('esprima');
const c = fs.readFileSync('static/js/store.js', 'utf8');
try {
  esprima.parseScript(c, { tolerant: false });
  console.log('ESPRIMA OK - file is valid');
} catch (e) {
  console.log('ESPRIMA ERROR:');
  console.log('  Message:', e.message);
  console.log('  Line:', e.lineNumber);
  console.log('  Col:', e.column);
  if (e.index) {
    console.log('  Context:', JSON.stringify(c.substring(Math.max(0, e.index-30), e.index+30)));
  }
}
