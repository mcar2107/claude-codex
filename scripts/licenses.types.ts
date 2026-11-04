/**
 * Поля package.json, которые нужны сборке лицензий.
 */
export type PackageManifest = {
  /**
   * Имя пакета.
   */
  name?: string;

  /**
   * Версия пакета.
   */
  version?: string;

  /**
   * SPDX-идентификатор лицензии.
   */
  license?: string;
};

/**
 * Пакет, чей код попал в бандл.
 */
export type BundledPackage = {
  /**
   * Каталог пакета в node_modules — там ищутся файлы лицензии.
   */
  directory: string;

  /**
   * Его package.json.
   */
  pkg: PackageManifest;
};
