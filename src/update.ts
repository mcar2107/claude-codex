import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import packageJson from '../package.json' with { type: 'json' };

import { isRecord, isStandalone } from './state';
import type { InstallReleaseOptions } from './update.types';

const { version } = packageJson;

const REPO = 'mcar2107/claude-codex';
const EXECUTABLE = 'claude-codex';
const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const API_TIMEOUT_MS = 30_000;

/**
 * Архив весит десятки мегабайт: потолок с запасом на медленную сеть, но зависшая загрузка не
 * держит команду бесконечно.
 */
const DOWNLOAD_TIMEOUT_MS = 600_000;

/**
 * Новый бинарник запускается с `--version` до замены старого: битая сборка не должна вытеснить
 * рабочую.
 */
const SMOKE_TIMEOUT_MS = 30_000;

const USAGE = 'Usage: claude-codex update [vX.Y.Z]';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;

const request = async (url: string, timeoutMs: number) => {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `claude-codex/${version}`,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  }

  return response;
};

/**
 * Канал обновления без тега — по запущенной версии. Prerelease (суффикс `-…`) берёт самый новый
 * релиз вместе с prerelease, как `install.sh` по умолчанию; стабильная версия — только
 * `releases/latest`, который prerelease не отдаёт.
 */
export const latestReleaseUrl = (current: string) => {
  return current.includes('-') ? `${RELEASES_API}?per_page=1` : `${RELEASES_API}/latest`;
};

const latestTag = async () => {
  const response = await request(latestReleaseUrl(version), API_TIMEOUT_MS);
  let body: unknown;

  try {
    body = await response.json();
  } catch {
    /**
     * Не-JSON (страница прокси) — то же, что ответ без тега: ошибка ниже.
     */
  }

  /**
   * Список релизов приходит массивом, `releases/latest` — одним объектом.
   */
  const release: unknown = Array.isArray(body) ? body[0] : body;
  const tag = isRecord(release) ? release.tag_name : undefined;

  if (typeof tag !== 'string' || !RELEASE_TAG.test(tag)) {
    throw new Error(`Could not determine the latest release of ${REPO}`);
  }

  return tag;
};

const downloadBytes = async (url: string) => {
  return (await request(url, DOWNLOAD_TIMEOUT_MS)).bytes();
};

const downloadText = async (url: string) => {
  return (await request(url, API_TIMEOUT_MS)).text();
};

/**
 * Имя сравнивается целиком, как в `install.sh`: `*` — признак бинарного режима `sha256sum`.
 */
const expectedHash = (sums: string, file: string) => {
  for (const line of sums.split('\n')) {
    const [hash, name] = line.trim().split(/\s+/);

    if (name === file || name === `*${file}`) {
      return hash;
    }
  }

  return undefined;
};

/**
 * Ассет под платформу текущего процесса: x64-бинарник под Rosetta обновляется x64-сборкой — той
 * же, что уже запускается.
 */
const currentAsset = () => {
  const { platform, arch } = process;

  if (
    (platform !== 'darwin' && platform !== 'linux') ||
    (arch !== 'arm64' && arch !== 'x64')
  ) {
    throw new Error(`No release binary for ${platform}-${arch}`);
  }

  return `${EXECUTABLE}-${platform}-${arch}`;
};

const defaultShareDir = () => {
  return (
    process.env.CLAUDE_CODEX_SHARE_DIR ||
    path.join(
      process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
      EXECUTABLE
    )
  );
};

/**
 * Ставит релиз поверх `target` так же, как `install.sh`: SHA256 из `SHA256SUMS`, запуск нового
 * бинарника и замена переименованием — запущенные сессии дорабатывают на старом файле.
 */
export const installRelease = async ({
  tag,
  target,
  asset,
  shareDir,
}: InstallReleaseOptions) => {
  const release = tag || (await latestTag());

  if (!RELEASE_TAG.test(release)) {
    throw new Error(`Expected a release tag such as v1.0.0, got ${release}`);
  }

  const next = release.slice(1);

  if (next === version) {
    console.log(`claude-codex ${version} is already installed.`);

    return 0;
  }

  /**
   * Без тега обновление только повышает версию: понижение — лишь по явному тегу.
   */
  if (!tag && Bun.semver.order(next, version) < 0) {
    console.log(
      `claude-codex ${version} is newer than the latest release ${release}; pass a tag to downgrade.`
    );

    return 0;
  }

  const base = `https://github.com/${REPO}/releases/download/${release}`;
  const archiveName = `${asset}.tar.gz`;

  console.log(`Downloading claude-codex ${release} (${asset})...`);
  const [archive, sums] = await Promise.all([
    downloadBytes(`${base}/${archiveName}`),
    downloadText(`${base}/SHA256SUMS`),
  ]);
  const expected = expectedHash(sums, archiveName);

  if (!expected) {
    throw new Error(`No checksum for ${archiveName} in SHA256SUMS`);
  }

  if (crypto.createHash('sha256').update(archive).digest('hex') !== expected) {
    throw new Error('Checksum mismatch; aborting');
  }

  const files = await new Bun.Archive(archive).files();
  const binary = files.get(`${asset}/${EXECUTABLE}`);

  if (!binary) {
    throw new Error(`Archive does not contain the ${EXECUTABLE} executable`);
  }

  /**
   * PID в имени: два одновременных `update` не пишут и не запускают один и тот же файл.
   */
  const temp = path.join(path.dirname(target), `.${EXECUTABLE}.new.${process.pid}`);

  try {
    await Bun.write(temp, binary);
    fs.chmodSync(temp, 0o755);
    const smoke = spawnSync(temp, ['--version'], {
      encoding: 'utf8',
      timeout: SMOKE_TIMEOUT_MS,
    });
    const reported = (smoke.stdout || '').trim();

    if (smoke.status !== 0 || reported !== next) {
      throw new Error(
        `Downloaded binary does not run as ${next} (reported ${reported || 'nothing'}); ${target} is unchanged`
      );
    }

    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }

  /**
   * Лицензии обновляются там, куда их положил `install.sh`; ручную установку без этого каталога
   * команда не расширяет. Бинарник к этому моменту уже заменён, поэтому сбой записи — только
   * предупреждение, а не провал обновления.
   */
  if (fs.existsSync(shareDir)) {
    try {
      for (const [entry, file] of files) {
        const name = path.posix.basename(entry);

        if (entry === `${asset}/${name}` && name !== EXECUTABLE) {
          await Bun.write(path.join(shareDir, name), file);
        }
      }
    } catch (error) {
      console.error(
        `Warning: could not update license notices in ${shareDir}: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  console.log(
    `Updated ${target}: ${version} -> ${next}. Restart running sessions: they keep ${version}, but their status line and /codex:* commands already run ${next}.`
  );

  return 0;
};

export const update = async (args: string[]) => {
  if (args.length > 1 || args[0]?.startsWith('-')) {
    throw new Error(USAGE);
  }

  if (!isStandalone()) {
    throw new Error(
      `update replaces the standalone binary; this CLI runs from ${process.argv[1]}. Pull and rebuild the checkout instead.`
    );
  }

  return installRelease({
    tag: args[0],
    target: fs.realpathSync(process.execPath),
    asset: currentAsset(),
    shareDir: defaultShareDir(),
  });
};
