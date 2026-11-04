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

/**
 * Побайтовое сравнение, а не `localeCompare`: порядок в файле не должен зависеть от локали
 * раннера.
 */
const byCodeUnits = (a: string, b: string) => {
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Файлы лицензий пакета: `LICENSE`, `LICENSE.md`, `LICENSE-MIT`, `LICENSE_APACHE`, `COPYING`,
 * `NOTICE`, `UNLICENSE`.
 */
const LICENSE_FILE = /^(un)?(licen[sc]e|copying|notice)([._-]|$)/i;

/**
 * Собирает тексты лицензий пакетов бандла в `THIRD_PARTY_LICENSES.txt` в корне репозитория;
 * возвращает число пакетов.
 */
export const writeLicenses = (metafile: BuildMetafile, root: string) => {
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
  /**
   * Ключ карты — `name@version`: две версии одного пакета тоже идут в стабильном порядке.
   */
  const sorted = [...packages.entries()].sort(([a], [b]) => {
    return byCodeUnits(a, b);
  });

  for (const [, { directory, pkg }] of sorted) {
    /**
     * Порядок `readdirSync` зависит от файловой системы — сортируем сами.
     */
    const names = fs
      .readdirSync(directory)
      .filter((name) => {
        return (
          LICENSE_FILE.test(name) && fs.statSync(path.join(directory, name)).isFile()
        );
      })
      .sort(byCodeUnits);

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
