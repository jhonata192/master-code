import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, isValidVersion, compareVersions, isNewerVersion } from '../src/update/semver.js';

test('1. parseVersion aceita semver valido', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [], build: [] });
  assert.equal(parseVersion('v0.1.0')?.major, 0);
  assert.equal(parseVersion('v0.1.0')?.patch, 0);
  assert.deepEqual(parseVersion('1.2.3-beta.1')?.prerelease, ['beta', '1']);
  assert.deepEqual(parseVersion('1.2.3+sha.abc')?.build, ['sha', 'abc']);
  assert.equal(parseVersion('1.2.3-beta.1+build.5')?.major, 1);
});

test('2. parseVersion rejeita versao invalida', () => {
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('foo'), null);
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion('1.2.3.4'), null);
  assert.equal(parseVersion('abc.def.ghi'), null);
  assert.equal(parseVersion('v1.x.0'), null);
});

test('3. isValidVersion', () => {
  assert.ok(isValidVersion('0.1.0'));
  assert.ok(isValidVersion('v0.1.0'));
  assert.ok(!isValidVersion('0.1'));
  assert.ok(!isValidVersion('latest'));
  assert.ok(!isValidVersion(''));
});

test('4. compareVersions ordena corretamente', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('1.1.0', '1.0.9'), 1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('0.9.9', '0.10.0'), -1);
});

test('5. compareVersions com prerelease', () => {
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-alpha'), 1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha'), 1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0-alpha'), 1);
  assert.equal(compareVersions('1.0.0-alpha.beta', '1.0.0-alpha.1'), 1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2'), -1);
});

test('6. compareVersions lanca em versao invalida', () => {
  assert.throws(() => compareVersions('foo', '1.0.0'));
  assert.throws(() => compareVersions('1.0.0', 'bar'));
});

test('7. isNewerVersion', () => {
  assert.ok(isNewerVersion('1.1.0', '1.0.0'));
  assert.ok(!isNewerVersion('1.0.0', '1.0.0'));
  assert.ok(!isNewerVersion('0.9.0', '1.0.0'));
  assert.ok(isNewerVersion('1.0.0-rc.1', '1.0.0-beta'));
  assert.ok(!isNewerVersion('invalid', '1.0.0'), 'versao invalida nao e "mais nova"');
  assert.ok(!isNewerVersion('1.0.0', 'invalid'), 'versao invalida atual nao dispara update');
});
