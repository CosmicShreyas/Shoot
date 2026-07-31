/**
 * Shared test helpers.
 */

import { saveConfig, type ShootConfig } from '../src/core/config.js';
import { writeTrust } from '../src/core/trust.js';

/**
 * Write a config AND record its commands as trusted — i.e. the state a real
 * `shoot init` leaves behind.
 *
 * Tests that exercise the verification pipeline want this. A bare `saveConfig`
 * leaves the commands unapproved, so the config-trust guard correctly skips
 * verification, which is not what those tests are checking. Use plain
 * `saveConfig` only when the untrusted state is the point.
 */
export function saveTrustedConfig(cwd: string, config: ShootConfig): void {
  saveConfig(cwd, config);
  writeTrust(cwd, config.checks);
}
