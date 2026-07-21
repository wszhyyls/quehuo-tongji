const fs = require('fs');
const parser = require('@babel/parser');
const c = fs.readFileSync('static/js/store.js', 'utf8');
const lines = c.split('\n');
const line624 = lines[623];
try {
  parser.parse(line624);
  console.log('Line 624 parses OK');
} catch (e) {
  console.log('Line 624 ERROR:', e.message);
  console.log('  Pos:', e.pos);
  if (e.pos) {
    console.log('  Around pos:', JSON.stringify(line624.substring(Math.max(0, e.pos-30), e.pos+30)));
  }
}
