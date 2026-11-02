import fs from 'fs';

const f = 'D:\\Users\\Administrator\\Desktop\\药品状态变更9_1新规则方案整理_20260917102528.json';
const raw = fs.readFileSync(f, 'utf8');
const j = JSON.parse(raw);

const convs = j.data.conversations;
let out = [];

for (const conv of convs) {
  out.push('===== CONVERSATION: ' + conv.name + ' =====');
  out.push('id=' + conv.id + ' createdAt=' + conv.createdAt + ' lastMessageAt=' + conv.lastMessageAt);
  for (const req of conv.requests) {
    out.push('\n----- REQUEST id=' + req.id + ' -----');
    for (const msg of req.messages) {
      const role = msg.role;
      let text = '';
      try {
        const m = JSON.parse(msg.message);
        if (m.content) {
          if (typeof m.content === 'string') {
            text = m.content;
          } else if (Array.isArray(m.content)) {
            const parts = [];
            for (const c of m.content) {
              if (c.type === 'text') parts.push(c.text);
              else if (c.type === 'reasoning') parts.push('[reasoning] ' + c.text);
              else if (c.type === 'tool-call') parts.push('[tool-call ' + c.toolName + '] ' + JSON.stringify(c.args));
              else if (c.type === 'tool-result') parts.push('[tool-result] ' + JSON.stringify(c.content).slice(0, 2000));
              else parts.push('[' + c.type + '] ' + JSON.stringify(c).slice(0, 1000));
            }
            text = parts.join('\n');
          }
        }
      } catch (e) {
        text = msg.message;
      }
      out.push('\n<<<' + role.toUpperCase() + '>>>\n' + text);
    }
  }
}

fs.writeFileSync('g:\\Trae项目\\缺货统计系统\\local-sync\\conv_extract.txt', out.join('\n'), 'utf8');
console.log('done, total chars', out.join('\n').length);
