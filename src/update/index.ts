export { getCurrentVersion } from './version.js';
export { compareVersions, isNewerVersion, isValidVersion, parseVersion } from './semver.js';
export type { ParsedVersion } from './semver.js';
export { GitHubReleaseClient, GitHubApiError } from './githubRelease.js';
export type { GitHubClientLike } from './githubRelease.js';
export { UpdateService } from './updateService.js';
export type { UpdateServiceOptions } from './updateService.js';
export { downloadToFile, DownloadError } from './download.js';
export type { DownloadProgress } from './download.js';
export { sha256File, sha256Hex, parseSha256Sums } from './checksum.js';
export {
  selectInstallerAsset,
  selectStandaloneAsset,
  selectChecksumAsset,
  isInstallerAsset,
  isStandaloneAsset,
  isChecksumAsset,
  launchUpdater,
  isInstalledExe,
  versionedAssetName,
} from './installer.js';
export type { InstallResult } from './installer.js';
export { isUpdaterInvocation, parseUpdaterArgs, runUpdater, UPDATE_FLAG } from './updater.js';
export { updateLogPath, appendLog } from './updateLog.js';
export { renderMarkdown, summarizeNotes, extractBulletPoints, truncateNotesLines, splitNotesLines, inline, plainText } from './markdown.js';
export { getCachedNotes, putNotes, clearNotesCache, listCachedNotes, notesCachePath } from './notesCache.js';
export { openUrlInBrowser } from './openUrl.js';
export { UPDATE_REPOSITORY, UPDATE_REPOSITORY_NAME, UPDATE_REPOSITORY_OWNER } from './repository.js';
export type {
  CheckResult,
  DownloadResult,
  GitHubAsset,
  GitHubRelease,
  NotesEntry,
  ReleaseNotesResult,
  UpdateChannel,
  UpdateStatus,
} from './types.js';
