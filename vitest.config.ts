import { defineConfig } from 'vitest/config';

/**
 * Vite and vite-node decide what counts as a Node builtin from
 * `module.builtinModules`, which deliberately omits the modules that are only
 * reachable with the `node:` prefix — `node:sqlite` among them. Left alone,
 * Vite strips the prefix, looks for a package called "sqlite", and the whole
 * store fails to load under test while working perfectly under Node.
 *
 * Rather than externalising (which vite-node ignores for SSR-transformed
 * modules), serve a virtual module that hands the real builtin back. Delete all
 * of this once Vite's builtin list catches up.
 */
const NODE_ONLY_BUILTINS = ['node:sqlite'];
const VIRTUAL_PREFIX = '\0chyme-builtin:';

export default defineConfig({
  plugins: [
    {
      name: 'chyme:node-only-builtins',
      enforce: 'pre',
      resolveId(id) {
        return NODE_ONLY_BUILTINS.includes(id) ? `${VIRTUAL_PREFIX}${id}` : null;
      },
      load(id) {
        if (!id.startsWith(VIRTUAL_PREFIX)) return null;
        const name = id.slice(VIRTUAL_PREFIX.length);
        return `const builtin = process.getBuiltinModule(${JSON.stringify(name)});
export default builtin;
export const { DatabaseSync, StatementSync, backup, constants } = builtin;`;
      },
    },
  ],
  test: {
    include: ['src/**/*.test.ts'],
  },
});
