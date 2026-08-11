export type UpdateChannel = 'stable' | 'beta' | 'alpha';

export interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
  content_type?: string;
}

export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubAsset[];
}

export interface NotesEntry {
  id: number;
  version: string;
  tagName: string;
  name: string | null;
  publishedAt: string | null;
  htmlUrl: string;
  body: string | null;
  fetchedAt: string;
}

export interface ReleaseNotesResult {
  ok: boolean;
  entry: NotesEntry | null;
  fromCache: boolean;
  error?: string;
}

export interface CheckResult {
  ok: boolean;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  release: GitHubRelease | null;
  checkedAt: string;
  fromCache: boolean;
  offline?: boolean;
  error?: string;
}

export interface DownloadResult {
  ok: boolean;
  version: string | null;
  filePath: string | null;
  fileName: string | null;
  size: number;
  checksum: string | null;
  offline?: boolean;
  error?: string;
}

export interface DownloadedInfo {
  version: string;
  fileName: string;
  path: string;
  checksum: string;
}

export interface UpdateStatus {
  currentVersion: string;
  channel: UpdateChannel;
  enabled: boolean;
  autoCheck: boolean;
  autoUpdate: boolean;
  lastUpdateCheck: string | null;
  lastKnownVersion: string | null;
  updateAvailable: boolean;
  downloaded: DownloadedInfo | null;
}
