#!/usr/bin/env node
'use strict';

// Build step (esbuild): one content-hashed, immutable bundle pair per web app.
//
// Each app ships TWO files, mirroring the dev page's two script phases:
//   <app>.boot.<hash>.js — the classic global-scope scripts (protocol.js + the
//     partyplug kit), concatenated and transform-minified. They must stay
//     top-level SCRIPT scope: their `var`s ARE the window globals the module
//     graph reads, so identifier minification stays off and they are never
//     wrapped into a module.
//   <app>.app.<hash>.js — the ES-module graph bundled from main.js with the
//     vendored Three.js resolved in (the dev importmap disappears with the
//     bundle) and fully minified. Dynamic imports (TestHarness) are inlined.
//
// dist/web-manifest.json maps app -> hashed filenames; server/index.js swaps
// the HTML's build:scripts / build:entry marker blocks for the hashed tags
// when the manifest is present, and serves the hashed files immutable.
// Content-addressed names are what let prod drop the blanket no-store on JS.
// Without a build (plain `npm run dev`, no manifest) pages serve the raw
// source modules exactly as before.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const TARGET = 'es2020';

const APPS = {
  display: {
    boot: [
      'public/shared/protocol.js',
      'partyplug/PartyConnection.js',
      'partyplug/RoomFlow.js',
      'partyplug/PartyFastlane.js',
    ],
    entry: 'public/display/main.js',
  },
  controller: {
    boot: [
      'public/shared/protocol.js',
      'partyplug/PartyConnection.js',
      'partyplug/PartyFastlane.js',
    ],
    entry: 'public/controller/main.js',
  },
};

// Hash the code only (NOT the trailing sourceMappingURL, which references the
// hash — that would be circular). The .map sits beside the bundle so a prod
// stack trace resolves into source; both are served immutable.
function writeHashed(app, kind, code, map) {
  const hash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 10);
  const file = `${app}.${kind}.${hash}.js`;
  const dir = path.join(ROOT, 'public', app);
  fs.writeFileSync(path.join(dir, file), code + `\n//# sourceMappingURL=${file}.map\n`);
  fs.writeFileSync(path.join(dir, file + '.map'), map);
  return file;
}

// Sweep stale content-hashed bundles (+ .map) so repeated local builds don't
// leave orphans. Source files lack the `.boot.`/`.app.` + hash segment and are
// untouched. (CI/Docker build from a clean tree, so this only matters locally.)
function sweepStale(app) {
  const dir = path.join(ROOT, 'public', app);
  const stale = new RegExp(`^${app}\\.(boot|app)\\.[0-9a-f]{10}\\.js`);
  for (const f of fs.readdirSync(dir)) {
    if (stale.test(f)) fs.rmSync(path.join(dir, f));
  }
}

async function buildBoot(app, scripts) {
  let source = '';
  for (const rel of scripts) {
    source += `// ==== ${rel} ====\n` + fs.readFileSync(path.join(ROOT, rel), 'utf8') + '\n';
  }
  const result = await esbuild.transform(source, {
    minifyWhitespace: true,
    minifySyntax: true,
    minifyIdentifiers: false, // top-level vars are the window API — keep names
    target: TARGET,
    legalComments: 'none',
    sourcemap: 'external',
    sourcefile: `${app}.boot.src.js`,
  });
  return writeHashed(app, 'boot', result.code, result.map);
}

async function buildApp(app, entry) {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, entry)],
    bundle: true,
    format: 'esm',
    target: TARGET,
    minify: true,
    sourcemap: 'external',
    legalComments: 'none',
    // The dev importmap's mapping, resolved at build time instead.
    alias: { three: path.join(ROOT, 'vendor', 'three', 'three.module.js') },
    outfile: `${app}.app.js`, // names the outputs; nothing is written (write:false)
    write: false,
  });
  let code = null, map = null;
  for (const out of result.outputFiles) {
    if (out.path.endsWith('.map')) map = out.text;
    else code = out.text.replace(/\n?\/\/# sourceMappingURL=.*\n?$/, '');
  }
  return writeHashed(app, 'app', code, map);
}

async function main() {
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  const manifest = {};
  // Apps are independent (different output dirs) — build them concurrently;
  // `npm start` runs this on every boot, so keep it quick.
  await Promise.all(Object.entries(APPS).map(async ([app, cfg]) => {
    sweepStale(app);
    const [boot, appFile] = await Promise.all([
      buildBoot(app, cfg.boot),
      buildApp(app, cfg.entry),
    ]);
    manifest[app] = { boot, app: appFile };
  }));
  fs.writeFileSync(
    path.join(ROOT, 'dist', 'web-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n'
  );
  for (const [app, m] of Object.entries(manifest)) {
    console.log(`build: public/${app}/${m.boot}`);
    console.log(`build: public/${app}/${m.app}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
