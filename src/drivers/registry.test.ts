import { describe, expect, it } from 'vitest';
import { ConfigError } from '../util/errors.js';
import { createDriver, createDriverFromConfig, driverIds, findDriverFactory } from './registry.js';
import { defaultConfig } from '../config/schema.js';

describe('driverIds', () => {
  it('lists what Chyme can talk to', () => {
    expect(driverIds()).toEqual(['github']);
  });
});

describe('findDriverFactory', () => {
  it('finds a known driver', () => {
    expect(findDriverFactory('github').id).toBe('github');
  });

  it('names the alternatives when the id is unknown', () => {
    try {
      findDriverFactory('gitlab');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('gitlab');
      expect((error as ConfigError).hint).toContain('github');
    }
  });
});

describe('createDriver', () => {
  it('builds a driver from a token', () => {
    const driver = createDriver('github', { token: 'ghp_example' });
    expect(driver.id).toBe('github');
    expect(driver.parseSourceKey('Acme/Widget')).toBe('acme/widget');
  });

  it('refuses missing credentials with something to do about it', () => {
    try {
      createDriver('github', undefined);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).hint).toContain('${GITHUB_TOKEN}');
    }
  });

  it('refuses an empty token, which would fail as a 401 much later', () => {
    expect(() => createDriver('github', { token: '' })).toThrow(ConfigError);
  });

  it('names the offending field when the credential shape is wrong', () => {
    try {
      createDriver('github', { pat: 'ghp_example' });
      expect.unreachable();
    } catch (error) {
      expect((error as ConfigError).message).toContain('credentials.github.token');
    }
  });
});

describe('createDriverFromConfig', () => {
  it('reads the driver’s own slice of the credentials', () => {
    const config = defaultConfig();
    config.credentials['github'] = { token: 'ghp_example' };
    expect(createDriverFromConfig('github', config).id).toBe('github');
  });

  it('reports the absence rather than building a driver that cannot work', () => {
    expect(() => createDriverFromConfig('github', defaultConfig())).toThrow(ConfigError);
  });
});
