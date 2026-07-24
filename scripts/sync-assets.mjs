// Build-time asset sync — RETIRED for site code files.
//
// This script used to overwrite public/index.html, public/app.js, and
// public/styles.css with copies from Supabase Storage at every Netlify build.
// That silently reverted committed work: Git had the newest code (Feed rename,
// feed-above-the-fold, auth fixes, new source pills), but every deploy shipped
// the stale storage snapshot instead.
//
// Git is now the single source of truth for all site code. Images and other
// binary assets are served directly from Supabase Storage via the /images/*
// redirect in netlify.toml, so nothing needs to be downloaded at build time.
//
// If a binary file ever needs to ship inside the deploy itself, add it to the
// list below — never add index.html, app.js, or styles.css back.
import { writeFile } from "node:fs/promises";

const BASE = "https://euixoavdzwaactdbxnpk.supabase.co/storage/v1/object/public/site-assets/site/";
const files = []; // intentionally empty — site code deploys from Git

for (const name of files) {
  const res = await fetch(`${BASE}${name}?v=${Date.now()}`);
  if (!res.ok) {
    console.error(`sync failed for ${name}: HTTP ${res.status}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(new URL(`../public/${name}`, import.meta.url), buf);
  console.log(`synced ${name} (${buf.length} bytes)`);
}
console.log("sync-assets: site code deploys from Git; nothing to sync.");
