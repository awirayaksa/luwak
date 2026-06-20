#!/usr/bin/env node
// Build the Luwak sidecar binary for the current platform's target triple.
// This is called by tauri's beforeBuildCommand and can be run directly.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

const TARGETS = {
  win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
  darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
  linux: { x64: "x86_64-unknown-linux-gnu", arm64: "aarch64-unknown-linux-gnu" },
};

const platform = process.platform;
const arch = process.arch;
const target = TARGETS[platform]?.[arch];

if (!target) {
  console.error(`luwak: unsupported platform ${platform}/${arch}`);
  process.exit(1);
}

const ext = platform === "win32" ? ".exe" : "";
const outDir = "src-tauri/binaries";
const outfile = `${outDir}/luwak-${target}${ext}`;

if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

console.log(`Building sidecar: ${outfile}`);
execSync(`bun build --compile src/index.ts --outfile "${outfile}"`, {
  stdio: "inherit",
});
console.log(`Sidecar built: ${outfile}`);
