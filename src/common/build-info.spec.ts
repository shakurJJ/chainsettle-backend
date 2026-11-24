import { Registry, Gauge } from 'prom-client';
import { resolveBuildInfo, readPackageVersion, UNKNOWN } from './build-info';
import { collectBuildInfo } from './metrics/metrics.module';

describe('resolveBuildInfo', () => {
  it('reports unknown for missing or blank build metadata (local runs)', () => {
    const info = resolveBuildInfo({
      GIT_SHA: '',
      BUILD_TIME: '   ',
    } as NodeJS.ProcessEnv);
    expect(info.gitSha).toBe(UNKNOWN);
    expect(info.buildTime).toBe(UNKNOWN);
    expect(info.version).toBe(readPackageVersion());
    expect(info.nodeVersion).toBe(process.version);
  });

  it('uses values injected at Docker build time', () => {
    const info = resolveBuildInfo({
      GIT_SHA: 'abc123',
      BUILD_TIME: '2026-09-29T10:00:00Z',
      APP_VERSION: '9.9.9',
    } as NodeJS.ProcessEnv);
    expect(info).toMatchObject({
      version: '9.9.9',
      gitSha: 'abc123',
      buildTime: '2026-09-29T10:00:00Z',
    });
  });

  it('returns undefined for an unreadable package.json', () => {
    expect(readPackageVersion('/definitely/not/here')).toBeUndefined();
  });
});

describe('chainsettle_build_info gauge', () => {
  it('exposes a single series with value 1 labelled with the build info', async () => {
    const registry = new Registry();
    const gauge = new Gauge({
      name: 'chainsettle_build_info',
      help: 'test',
      labelNames: ['version', 'gitSha', 'buildTime', 'nodeVersion'],
      registers: [registry],
      collect: collectBuildInfo,
    });
    expect(gauge).toBeDefined();

    const text = await registry.metrics();
    const line = text.split('\n').find((l) => l.startsWith('chainsettle_build_info{'));
    expect(line).toBeDefined();
    expect(line).toContain(`nodeVersion="${process.version}"`);
    expect(line!.trim().endsWith(' 1')).toBe(true);
    // Collected twice: still one series.
    const again = await registry.metrics();
    expect(again.split('\n').filter((l) => l.startsWith('chainsettle_build_info{'))).toHaveLength(1);
  });
});
