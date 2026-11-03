/* Zero-dependency build. Node.js 18+; no npm install required. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = __dirname;
const manifest = require('./manifest.json');
function build(output = path.join(root, 'tbrain_tool_for_labeler.user.js')) {
    const chunks = [fs.readFileSync(path.join(root, 'userscript.header.txt'), 'utf8'),
        '\n(function () {\n    "use strict";\n    const factories = Object.create(null);\n'];
    for (const entry of manifest.modules) {
        const code = fs.readFileSync(path.join(root, entry.file), 'utf8');
        new vm.Script(code, { filename: entry.file });
        if (!/module\.exports\s*=\s*function\b/.test(code)) throw new Error('Expected factory: ' + entry.file);
        chunks.push('\n// MODULE: ' + entry.name + '\n' + code.replace(/module\.exports\s*=/, 'factories.' + entry.name + ' ='));
    }
    chunks.push('\n    const modules = Object.create(null);\n');
    for (const entry of manifest.modules) chunks.push(`    modules.${entry.name} = factories.${entry.name}(modules);\n`);
    chunks.push('\n    // Register hooks only after every module and live binding exists.\n');
    for (const entry of manifest.modules.filter(x => x.init)) chunks.push(`    modules.${entry.name}.init();\n`);
    chunks.push('    modules.bootstrap.start();\n})();\n');
    const result = chunks.join('');
    new vm.Script(result, { filename: path.basename(output) });
    fs.writeFileSync(output, result);
    return result;
}
module.exports = { build };
if (require.main === module) { const output = process.argv[2] ? path.resolve(process.argv[2]) : undefined; const result = build(output); console.log('Built ' + manifest.modules.length + ' modules, ' + Buffer.byteLength(result) + ' bytes.'); }
