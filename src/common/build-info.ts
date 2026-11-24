import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Build/version info for the running process (#427).
 *
 * `GIT_SHA`, `BUILD_TIME` and `APP_VERSION` are baked into the Docker image at
 * build time (see Dockerfile). Locally they are unset and report `unknown`;
 * the version falls back to package.json.
 */
export interface BuildInfo {
  version: string;
  gitSha: string;
  buildTime: string;
  nodeVersion: string;
}

export const UNKNOWN = 'unknown';

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

export function readPackageVersion(root: string = process.cwd()): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export function resolveBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    version: clean(env.APP_VERSION) ?? readPackageVersion() ?? UNKNOWN,
    gitSha: clean(env.GIT_SHA) ?? UNKNOWN,
    buildTime: clean(env.BUILD_TIME) ?? UNKNOWN,
    nodeVersion: process.version,
  };
}
