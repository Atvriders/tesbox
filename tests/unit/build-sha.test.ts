import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execSync: vi.fn() }));

import { execSync } from 'node:child_process';
import { resolveBuildSha } from '../../deploy/build-sha';

const execMock = vi.mocked(execSync);

describe('resolveBuildSha', () => {
  afterEach(() => {
    execMock.mockReset();
  });

  it('uses the first 7 characters of GITHUB_SHA without calling git', () => {
    expect(resolveBuildSha({ GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567' })).toBe(
      '0123456',
    );
    expect(execMock).not.toHaveBeenCalled();
  });

  it('falls back to git rev-parse with stderr ignored when GITHUB_SHA is unset', () => {
    execMock.mockReturnValue('abc1234\n');
    expect(resolveBuildSha({})).toBe('abc1234');
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock).toHaveBeenCalledWith('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  });

  it('treats an empty or blank GITHUB_SHA as unset', () => {
    execMock.mockReturnValue('fedcba9\n');
    expect(resolveBuildSha({ GITHUB_SHA: '' })).toBe('fedcba9');
    expect(resolveBuildSha({ GITHUB_SHA: '   ' })).toBe('fedcba9');
  });

  it("returns 'dev' when git fails", () => {
    execMock.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });
    expect(resolveBuildSha({})).toBe('dev');
  });

  it("returns 'dev' when git prints nothing", () => {
    execMock.mockReturnValue('   \n');
    expect(resolveBuildSha({})).toBe('dev');
  });
});
