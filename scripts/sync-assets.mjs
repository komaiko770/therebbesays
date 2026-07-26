// Build-time patcher (runs as the Netlify build command).
//
// History: this file used to OVERWRITE public/index.html, app.js and styles.css with
// snapshots from Supabase Storage — which silently reverted every committed change on
// each deploy. That sync is permanently retired: Git is the single source of truth.
//
// Now it applies small deterministic flag patches to public/app.js that would otherwise
// require rewriting the whole 60KB file for a one-line change. Every replacement MUST
// match exactly once or the build fails loudly — no silent drift.
import { readFile, writeFile } from "node:fs/promises";

const TARGET = new URL("../public/app.js", import.meta.url);

const REPLACEMENTS = [
  {
    reason: "Enforce the client-side sign-in gate for starting new research (owner request, 26 Jul)",
    from: "const AUTH_GATE_ENABLED = false;",
    to: "const AUTH_GATE_ENABLED = true;",
  },
];

let source = await readFile(TARGET, "utf8");
for (const { reason, from, to } of REPLACEMENTS) {
  const occurrences = source.split(from).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `apply-flags: expected exactly 1 occurrence of ${JSON.stringify(from)} in public/app.js, found ${occurrences}. ` +
      `(${reason}) — refusing to build with silent drift.`,
    );
  }
  source = source.replace(from, to);
  console.log(`patched app.js: ${reason}`);
}
await writeFile(TARGET, source);
console.log("apply-flags complete");
