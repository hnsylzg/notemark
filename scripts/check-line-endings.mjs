import { spawnSync } from "node:child_process";

const result = spawnSync("git", ["ls-files", "--eol", "-z"], {
  cwd: process.cwd(),
  encoding: "buffer",
});

if (result.error) {
  console.error(`Unable to inspect tracked files: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  console.error(result.stderr.toString("utf8").trim());
  process.exit(result.status ?? 1);
}

const records = result.stdout
  .toString("utf8")
  .split("\0")
  .filter(Boolean);
const invalid = [];
let textFiles = 0;

for (const record of records) {
  const separator = record.indexOf("\t");
  if (separator < 0) continue;
  const metadata = record.slice(0, separator);
  const path = record.slice(separator + 1);
  if (metadata.includes("attr/-text")) continue;
  textFiles += 1;
  if (/(?:^|\s)(?:i|w)\/(?:crlf|mixed)(?=\s|$)/.test(metadata)) {
    invalid.push(path);
  }
}

if (invalid.length > 0) {
  console.error("CRLF or mixed line endings found:");
  for (const path of invalid) console.error(`  ${path}`);
  console.error("Run `git add --renormalize .` and commit the result.");
  process.exit(1);
}

console.log(`Line endings OK: ${textFiles} tracked text files use LF.`);
