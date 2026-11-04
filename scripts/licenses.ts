import fs from 'node:fs';
import path from 'node:path';

import type { BuildMetafile } from 'bun';

import type { BundledPackage, PackageManifest } from './licenses.types';

/**
 * Пакеты без файла лицензии в npm-архиве: текст лежит в licenses/ репозитория.
 */
const SUPPLEMENTAL: Record<string, string> = {
  'abstract-logging@2.0.1': 'abstract-logging-2.0.1.html',
  'tiktoken@1.0.22': 'tiktoken-1.0.22.txt',
};

/**
 * Ближайший к файлу package.json с именем и версией — у вложенных каталогов пакета бывают
 * package.json без них (`{"type": "module"}`).
 */
const ownerPackage = (file: string, nodeModules: string): BundledPackage | undefined => {
  let directory = path.dirname(file);

  while (directory.startsWith(nodeModules + path.sep)) {
    const manifest = path.join(directory, 'package.json');

    if (fs.existsSync(manifest)) {
      const pkg: PackageManifest = JSON.parse(fs.readFileSync(manifest, 'utf8'));

      if (pkg.name && pkg.version) return { directory, pkg };
    }

    directory = path.dirname(directory);
  }

  return undefined;
};

export const licenses = (metafile: BuildMetafile, root: string) => {
  const nodeModules = path.join(root, 'node_modules');
  /**
   * Ключ — имя и версия: установка может положить одну версию пакета в несколько каталогов,
   * текст лицензии при этом один.
   */
  const packages = new Map<string, BundledPackage>();

  for (const input of Object.keys(metafile.inputs)) {
    const file = path.resolve(root, input);

    if (!file.startsWith(nodeModules + path.sep)) continue;
    const owner = ownerPackage(file, nodeModules);

    if (owner) packages.set(`${owner.pkg.name}@${owner.pkg.version}`, owner);
  }

  const texts = [
    'Bundled third-party licenses. Generated from actual Bun.build inputs.\nCCR source license is also provided separately as vendor/ccr/LICENSE.\n',
  ];
  const sorted = [...packages.values()].sort((a, b) => {
    return String(a.pkg.name).localeCompare(String(b.pkg.name));
  });

  for (const { directory, pkg } of sorted) {
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
      const supplemental = SUPPLEMENTAL[`${pkg.name}@${pkg.version}`];

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
};
