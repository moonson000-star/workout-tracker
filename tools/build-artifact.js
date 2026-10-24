// claude.ai Artifact용 단일 HTML 생성: node tools/build-artifact.js <출력경로>
// index.html의 본문에 CSS와 JS를 인라인으로 넣고, PWA 전용 head 태그는 제외
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const out = process.argv[2];
if (!out) throw new Error('usage: node tools/build-artifact.js <output.html>');

const html = read('index.html');
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/\s*<script src="[^"]+"><\/script>/g, '');
const scripts = ['exercises.js', 'calc.js', 'app.js'].map(read).join('\n');

fs.writeFileSync(out, `<title>운동 기록</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${read('style.css')}
</style>
${body.trim()}
<script>
${scripts}
</script>
`);
console.log('wrote', out);
