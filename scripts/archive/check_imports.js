const fs = require('fs');
const path = require('path');

const backendDir = path.join(__dirname, '..');
const scriptsDir = path.join(backendDir, 'scripts');

const scriptFiles = fs.readdirSync(scriptsDir).filter(f => f.endsWith('.js') && f !== 'check_imports.js');

function getAllJsFiles(dir, fileList = []) {
    const files = fs.readdirSync(dir);
    files.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            if (file !== 'node_modules' && file !== 'scripts' && file !== 'migrations') {
                getAllJsFiles(filePath, fileList);
            }
        } else {
            if (file.endsWith('.js')) {
                fileList.push(filePath);
            }
        }
    });
    return fileList;
}

const prodFiles = [
    path.join(backendDir, 'server.js'),
    ...getAllJsFiles(path.join(backendDir, 'controllers')),
    ...getAllJsFiles(path.join(backendDir, 'routes')),
    ...getAllJsFiles(path.join(backendDir, 'services')),
    ...getAllJsFiles(path.join(backendDir, 'models'))
];

const results = [];

scriptFiles.forEach(script => {
    let foundIn = [];
    const baseName = script.replace('.js', '');
    prodFiles.forEach(prodFile => {
        const content = fs.readFileSync(prodFile, 'utf8');
        // Regex to check require or import of scripts/scriptName or scripts/scriptName.js
        const regex = new RegExp(`require\\s*\\([\"'].*scripts[/\\\\]${baseName}(\\.js)?[\"']\\)`, 'i');
        const regexAlt = new RegExp(`from\\s+[\"'].*scripts[/\\\\]${baseName}(\\.js)?[\"']`, 'i');
        if (regex.test(content) || regexAlt.test(content)) {
            const relPath = path.relative(backendDir, prodFile);
            foundIn.push(relPath);
        }
    });
    results.push({
        file: script,
        imported: foundIn.length > 0 ? `Y (${foundIn.join(', ')})` : 'N',
        verdict: foundIn.length > 0 ? 'PRODUCTION' : 'TEST-ONLY / MANUAL UTILITY'
    });
});

console.log('| File Name | Kisi production file se import hoti hai? (Y/N + kaha) | Verdict |');
console.log('|---|---|---|');
results.forEach(r => {
    console.log(`| [` + r.file + `](rcm-ai-backend/scripts/` + r.file + `) | ${r.imported} | ${r.verdict} |`);
});
