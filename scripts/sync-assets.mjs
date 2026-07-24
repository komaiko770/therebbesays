// Downloads the latest reviewed site files from durable storage at build time.
// This keeps binary-safe + large assets out of the text-only publishing pipeline.
import { writeFile } from "node:fs/promises";

const BASE = "https://euixoavdzwaactdbxnpk.supabase.co/storage/v1/object/public/site-assets/site/";
const files = ["index.html", "app.js", "styles.css"];

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
