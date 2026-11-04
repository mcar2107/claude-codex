#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const vendor = path.join(root, 'vendor/ccr');

/**
 * Сверяет vendor/ccr с хешами upstream из `original-sha256.json` (vendor.md): правка vendor не
 * должна молча доехать до бандла и релиза. Сверяются файлы манифеста; отсутствующий файл —
 * расхождение.
 */
export const verifyVendor = async () => {
  const expected: unknown = await Bun.file(
    path.join(vendor, 'original-sha256.json')
  ).json();

  if (typeof expected !== 'object' || expected === null) {
    throw new Error('vendor/ccr/original-sha256.json: expected a JSON object');
  }

  const drifted = Object.entries(expected).reduce<string[]>((result, [file, hash]) => {
    const absolute = path.join(vendor, file);
    const actual = fs.existsSync(absolute)
      ? new Bun.CryptoHasher('sha256').update(fs.readFileSync(absolute)).digest('hex')
      : undefined;

    if (actual !== hash) {
      result.push(file);
    }

    return result;
  }, []);

  if (drifted.length) {
    throw new Error(
      `vendor/ccr differs from upstream (original-sha256.json): ${drifted.join(', ')}`
    );
  }
};

if (import.meta.main) {
  await verifyVendor();
}
