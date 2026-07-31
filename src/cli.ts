#!/usr/bin/env node
/**
 * Shoot CLI entry point.
 *
 * Argument parsing is hand-rolled on purpose — no commander/yargs. The whole
 * point of Shoot is that you can audit it in one sitting, and that budget does
 * not survive a dependency tree.
 */

const USAGE = `
shoot — verify before you grow

Usage:
  shoot init         Set up the stop hook and write .shoot.config.json
  shoot verify       Run all configured checks once and print the result
  shoot doctor       Diagnose common setup problems
  shoot stats        Summarize local verification history
  shoot status       Show current config and hook registration
  shoot uninstall    Remove the hook and config
  shoot hook         Internal: run as a stop hook (reads stdin)

Options:
  -h, --help         Show this help
  -v, --version      Show version
`.trimStart();

const VERSION = '0.1.0';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command === '-v' || command === '--version') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  switch (command) {
    case 'init': {
      const { init } = await import('./commands/init.js');
      return init(rest);
    }
    case 'verify': {
      const { verify } = await import('./commands/verify.js');
      return verify(rest);
    }
    case 'doctor': {
      const { doctor } = await import('./commands/doctor.js');
      return doctor(rest);
    }
    case 'stats': {
      const { stats } = await import('./commands/stats.js');
      return stats(rest);
    }
    case 'status': {
      const { status } = await import('./commands/status.js');
      return status(rest);
    }
    case 'uninstall': {
      const { uninstall } = await import('./commands/uninstall.js');
      return uninstall(rest);
    }
    case 'hook': {
      const { runHook } = await import('./commands/hook.js');
      return runHook();
    }
    default: {
      process.stderr.write(`shoot: unknown command "${command}"\n\n${USAGE}`);
      return 2;
    }
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`shoot: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
