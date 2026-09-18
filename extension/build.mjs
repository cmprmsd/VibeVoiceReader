import * as esbuild from "esbuild";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
const outdir = "dist";

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync("static", outdir, { recursive: true });
// lamejs' bundled build assigns its API onto a top-level function without
// exporting it; vendor a copy with an ES export appended.
mkdirSync("src/vendor", { recursive: true });
writeFileSync("src/vendor/lame.js", readFileSync("node_modules/lamejs/lame.all.js", "utf8") + "\nexport default lamejs;\n");
if (process.env.VV_SELFTEST) {
  // The self-test injects into a page without a user gesture, which needs a
  // real host permission; never shipped in normal builds.
  const mf = JSON.parse(readFileSync(`${outdir}/manifest.json`, "utf8"));
  mf.host_permissions = [...mf.host_permissions, "<all_urls>"];
  writeFileSync(`${outdir}/manifest.json`, JSON.stringify(mf, null, 2));
}

// Readability assigns innerHTML twice (on a detached document clone, so it is
// harmless), which the add-on linter flags.  Rewrite both to DOM operations.
const readabilityPatch = {
  name: "readability-no-innerhtml",
  setup(build) {
    build.onLoad({ filter: /@mozilla[\\/]readability[\\/]Readability\.js$/ }, async (args) => {
      let src = readFileSync(args.path, "utf8");
      const patches = [
        ["var pageCacheHtml = page.innerHTML;", "var pageCacheNodes = Array.from(page.childNodes, function (n) { return n.cloneNode(true); });"],
        ["page.innerHTML = pageCacheHtml;", "page.replaceChildren.apply(page, pageCacheNodes.map(function (n) { return n.cloneNode(true); }));"],
        ["tmp.innerHTML = noscript.innerHTML;", "tmp.replaceChildren.apply(tmp, Array.from(new DOMParser().parseFromString(noscript.innerHTML, \"text/html\").body.childNodes));"],
      ];
      for (const [from, to] of patches) {
        if (!src.includes(from)) throw new Error(`readability patch: pattern not found: ${from}`);
        src = src.replace(from, to);
      }
      return { contents: src, loader: "js" };
    });
  },
};

const ctx = await esbuild.context({
  plugins: [readabilityPatch],
  entryPoints: {
    background: "src/background.ts",
    content: "src/content/index.ts",
    options: "src/options/options.ts",
  },
  bundle: true,
  format: "iife",
  target: ["firefox128"],
  outdir,
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": watch ? '"development"' : '"production"',
    __SELFTEST__: process.env.VV_SELFTEST ? "true" : "false",
  },
});

if (watch) {
  await ctx.watch();
  console.log("watching…");
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
