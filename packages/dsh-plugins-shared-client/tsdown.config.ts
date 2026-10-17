/**
 * Client bundle.
 *
 * One CJS file that both serves the components and acts as the plugin half —
 * see the header of `src/client/index.tsx` for why it has to be one file.
 *
 * `react` and friends are never bundled: the loader answers them from its
 * platform seed table, and a second copy of React in the page would break
 * hooks in the host's own components.
 *
 * `banner` and `footer` are objects rather than strings because they attach to
 * every emitted file. The loader wrapper belongs on the JavaScript only:
 * prepending `window.__ModuleLoader__.load({` to `lib/client.d.ts` would leave
 * the TypeScript consumers that import these components
 * (`dsh-config-manager`, `dsh-imagegen`) with a declaration file tsc cannot
 * parse.
 */
import { defineConfig } from 'tsdown'

const LOADER_ID = '@logictan/dsh-plugins-shared-client'

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: false,
  hash: false,
  deps: {
    neverBundle: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  },
  outExtensions: ({ format }) => (format === 'cjs' ? { js: '.js', dts: '.d.ts' } : undefined),
  // The loader protocol: the bundle registers a factory and returns its exports.
  banner: {
    js: `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(LOADER_ID)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n`,
    dts: '',
  },
  footer: {
    js: `\n\t\treturn module.exports;\n\t}\n});\n`,
    dts: '',
  },
})
