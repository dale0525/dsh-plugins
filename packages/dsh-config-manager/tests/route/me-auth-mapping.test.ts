import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isGitHubAuthMissing } from '../../src/index.ts';
import { GitHubAuthError } from '../../src/sync/github-auth.ts';

const here = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

test('M1 isGitHubAuthMissing：no_token（未配置 token）与 unauthorized（401 失效）同属未登录', () => {
  assert.equal(isGitHubAuthMissing(new GitHubAuthError('GitHub token 未配置（请先登录）', 'no_token')), true);
  assert.equal(isGitHubAuthMissing(new GitHubAuthError('Bad credentials', 'unauthorized', 401)), true);
});

test('M2 isGitHubAuthMissing：真实故障 / 非 GitHubAuthError 一律 false（仍按 500 暴露，不伪装成未登录）', () => {
  for (const code of ['network_error', 'rate_limited', 'server_error', 'validation_failed', 'fork_timeout']) {
    assert.equal(isGitHubAuthMissing(new GitHubAuthError(`boom:${code}`, code)), false, `${code} 不得判为未登录`);
  }
  assert.equal(isGitHubAuthMissing(new Error('boom')), false, '普通 Error 不得判为未登录');
  assert.equal(isGitHubAuthMissing(undefined), false);
  assert.equal(isGitHubAuthMissing(null), false);
  assert.equal(isGitHubAuthMissing('no_token'), false, '只认 GitHubAuthError 实例，不按字符串匹配');
});

