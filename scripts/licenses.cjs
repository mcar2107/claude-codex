const fs = require('node:fs');
const path = require('node:path');

function licenses(metafile, root) {
  const packages = new Map();

  for (const input of Object.keys(metafile.inputs)) {
    if (!input.startsWith('node_modules/')) continue;
    let directory = path.dirname(path.resolve(root, input));

    while (directory.startsWith(path.join(root, 'node_modules') + path.sep)) {
      const manifest = path.join(directory, 'package.json');

      if (fs.existsSync(manifest)) {
        const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));

        if (!pkg.name || !pkg.version) {
          directory = path.dirname(directory);
          continue;
        }

        packages.set(directory, pkg);
        break;
      }

      directory = path.dirname(directory);
    }
  }

  const texts = [
    'Bundled third-party licenses. Generated from actual esbuild inputs.\nCCR source license is also provided separately as vendor/ccr/LICENSE.\n',
  ];

  for (const [directory, pkg] of [...packages].sort((a, b) => {
    return a[1].name.localeCompare(b[1].name);
  })) {
    const names = fs.readdirSync(directory).filter((name) => {
      return (
        /^(licen[sc]e|copying|notice)(\.|$)/i.test(name) &&
        fs.statSync(path.join(directory, name)).isFile()
      );
    });

    texts.push(
      `\n${'='.repeat(72)}\n${pkg.name}@${pkg.version} — ${pkg.license || 'see license below'}\n`
    );

    if (!names.length) {
      const supplemental = {
        'abstract-logging@2.0.1': 'abstract-logging-2.0.1.html',
        'tiktoken@1.0.22': 'tiktoken-1.0.22.txt',
      }[`${pkg.name}@${pkg.version}`];

      if (!supplemental)
        throw new Error(
          `Missing license text for bundled dependency ${pkg.name}@${pkg.version}`
        );
      texts.push(fs.readFileSync(path.join(root, 'licenses', supplemental), 'utf8'));
    }

    for (const name of names)
      texts.push(
        `\n--- ${name} ---\n${fs.readFileSync(path.join(directory, name), 'utf8')}\n`
      );
  }

  fs.writeFileSync(path.join(root, 'THIRD_PARTY_LICENSES.txt'), texts.join(''));

  return packages.size;
}

module.exports = { licenses };
