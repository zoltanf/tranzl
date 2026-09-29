// Builds an isolated evaluation app with a different identity and entry point.
// Does not install, publish, modify the product package, or copy user assets.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pack, root } = require('./pack.cjs');
const out = path.resolve(process.argv[2] || path.join(root, 'out/runtime-package'));
const source = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirtyFiles: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean),
};
pack({ name: 'TranzlRuntimeEvaluation', appBundleId: 'com.tranzl.runtime-evaluation', out,
  afterCopy: [async ({ buildPath }) => {
    const file = path.join(buildPath, 'package.json'), pkg = JSON.parse(await fs.readFile(file));
    pkg.main = 'scripts/evaluate-runtime.cjs';
    await fs.writeFile(file, JSON.stringify(pkg, null, 2) + '\n');
    await fs.mkdir(path.join(buildPath, 'scripts'), { recursive: true });
    await fs.copyFile(path.join(root, 'scripts/evaluate-runtime.cjs'), path.join(buildPath, 'scripts/evaluate-runtime.cjs'));
    await fs.writeFile(path.join(buildPath, 'evaluation-source.json'), JSON.stringify(source, null, 2) + '\n');
  }],
}).then(paths => console.log(paths.join('\n'))).catch(error => { console.error(error); process.exitCode = 1; });
