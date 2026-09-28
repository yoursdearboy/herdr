import { spawnSync } from 'node:child_process';

const herdr = process.env.HERDR_BIN_PATH || 'herdr';
const result = spawnSync(herdr, ['plugin', 'pane', 'open', '--plugin', process.env.HERDR_PLUGIN_ID, '--entrypoint', 'dashboard', '--placement', 'overlay'], { stdio: 'inherit' });
if (result.error) {
  console.error(`Could not open the dashboard pane: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
