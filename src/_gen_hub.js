const fs = require('fs');
const base = 'C:/Users/。。/WorkBuddy/麻将';
const manual = fs.readFileSync(base + '/tools/manual_paipu_tool.html', 'utf8');
const current = fs.readFileSync(base + '/tools/current_board_generator.html', 'utf8');
const naga = fs.readFileSync(base + '/scripts/NAGA_ANALYZE-0.2.0.user.js', 'utf8');
const nagaB64 = Buffer.from(naga, 'utf8').toString('base64');

let tpl = fs.readFileSync(base + '/tools/_hub_template.html', 'utf8');
tpl = tpl.replace(/__MANUAL__/g, () => manual);
tpl = tpl.replace(/__CURRENT__/g, () => current);
tpl = tpl.replace(/__NAGA_B64__/g, () => nagaB64);

fs.mkdirSync(base + '/tools/hub', { recursive: true });
fs.writeFileSync(base + '/tools/hub/index.html', tpl);
console.log('written', base + '/tools/hub/index.html', tpl.length, 'bytes');
