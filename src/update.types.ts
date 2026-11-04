/**
 * Что и куда ставит `installRelease`.
 */
export type InstallReleaseOptions = {
  /**
   * Тег релиза (`v1.0.0`); без него — последний стабильный релиз (`releases/latest`).
   */
  tag?: string;

  /**
   * Путь заменяемого бинарника — настоящий файл, а не симлинк на него.
   */
  target: string;

  /**
   * Имя ассета без `.tar.gz`: `claude-codex-darwin-arm64`.
   */
  asset: string;

  /**
   * Каталог лицензий, куда их кладёт `install.sh`; обновляется, только если уже существует.
   */
  shareDir: string;
};
