/**
 * commands/index.js — the external command table.
 *
 * Every module in this folder exports a default array of command objects
 * (ARCHITECTURE §17). This file gathers them into the single named export
 * `commands`, which js/apps/terminal/index.js registers with the shell.
 *
 * Modules are loaded with dynamic `import()` and settled independently rather
 * than with static imports, so one broken or missing command module costs you
 * that module's commands instead of the entire terminal. Failures are reported
 * once, loudly, to the console.
 *
 * Shell builtins (cd, export, alias, history …) do NOT live here — they mutate
 * shell state and are implemented in ../builtins.js.
 */

/**
 * Modules that contribute commands, in registration order.
 *
 * `system.js` is itself an aggregator — it re-exports `system-hw.js`,
 * `ps-top.js` and `fetch.js` alongside its own commands, so those three must
 * NOT be listed here or every command in them registers twice.
 *
 * `extras.js` is an aggregator on the same pattern, pulling in the
 * `extras-*.js` siblings, so those must not be listed here either.
 */
const MODULES = [
  './files.js',
  './text.js',
  './system.js',
  './net.js',
  './pkg.js',
  './ai.js',
  './misc.js',
  './extras.js',
];

/** @type {string[]} modules that failed to load, for diagnostics */
export const failedModules = [];

/**
 * Pull the command array out of a loaded module.
 * Accepts `export default [...]` (the contract) and tolerates a module that
 * exports a named `commands` array instead.
 *
 * @param {object} mod
 * @param {string} spec
 * @returns {object[]}
 */
function commandsOf(mod, spec) {
  const list = Array.isArray(mod?.default)
    ? mod.default
    : Array.isArray(mod?.commands)
      ? mod.commands
      : null;

  if (!list) {
    console.error(
      `[terminal] ${spec} must default-export an array of commands; got:`,
      mod?.default,
    );
    return [];
  }
  return list;
}

const settled = await Promise.allSettled(MODULES.map((spec) => import(spec)));

const collected = [];
const seen = new Map();

settled.forEach((result, i) => {
  const spec = MODULES[i];

  if (result.status === 'rejected') {
    failedModules.push(spec);
    console.error(`[terminal] failed to load ${spec}:`, result.reason);
    return;
  }

  for (const cmd of commandsOf(result.value, spec)) {
    if (!cmd || typeof cmd.name !== 'string' || typeof cmd.run !== 'function') {
      console.warn(`[terminal] ${spec} contains an invalid command object:`, cmd);
      continue;
    }
    // First registration wins, matching PATH order. A duplicate is almost
    // always a copy-paste mistake, so say so rather than shadowing silently.
    const prev = seen.get(cmd.name);
    if (prev) {
      console.warn(
        `[terminal] duplicate command "${cmd.name}": ${spec} ignored, ${prev} kept.`,
      );
      continue;
    }
    seen.set(cmd.name, spec);
    collected.push(cmd);
  }
});

if (failedModules.length) {
  console.warn(
    `[terminal] ${failedModules.length} of ${MODULES.length} command modules ` +
      `failed to load (${failedModules.join(', ')}). ` +
      'The terminal is running with a reduced command set.',
  );
}

/** @type {object[]} every external command, ready for registerCommand() */
export const commands = collected;

export default commands;
