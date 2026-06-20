#!/usr/bin/env node
// Package a portable Luwak desktop release as a zip.
// Runs after `cargo tauri build` and zips the raw exe + sidecar + dll.
import {
  existsSync,
  readFileSync,
  statSync,
  mkdirSync,
  createWriteStream,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Support `--target <triple>` for cross-compiled output directories.
const targetArgIdx = process.argv.indexOf("--target");
const targetTriple = targetArgIdx !== -1 ? process.argv[targetArgIdx + 1] : null;
const targetSubdir = targetTriple ? targetTriple : "release";
const releaseDir = join(root, "src-tauri", "target", targetSubdir, targetTriple ? "release" : "");
const outDir = join(releaseDir, "bundle", "portable");

const PLATFORM = process.platform;
const EXT = PLATFORM === "win32" ? ".exe" : "";
const DLL_EXT = PLATFORM === "win32" ? ".dll" : PLATFORM === "macos" ? ".dylib" : ".so";

function crc32(buf) {
  let table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries, outPath) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = deflateRawSync(data);
    const crc = crc32(data);
    const useCompressed = compressed.length < data.length;
    const stored = useCompressed ? compressed : data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(useCompressed ? 8 : 0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(Buffer.concat([local, nameBuf, stored]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(useCompressed ? 8 : 0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([central, nameBuf]));

    offset += local.length + nameBuf.length + stored.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of centralParts) centralSize += c.length;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);

  mkdirSync(outDir, { recursive: true });
  const outPathFull = join(outDir, "Luwak-portable.zip");
  const stream = createWriteStream(outPathFull);
  for (const l of localParts) stream.write(l);
  for (const c of centralParts) stream.write(c);
  stream.write(end);

  return new Promise((resolve) => {
    stream.end(() => {
      const sizeMB = (statSync(outPathFull).size / 1024 / 1024).toFixed(1);
      console.log(`Portable package: ${outPathFull} (${sizeMB} MB)`);
      resolve();
    });
  });
}

function addIfExists(entries, srcName, zipName) {
  const src = join(releaseDir, srcName);
  if (existsSync(src)) {
    entries.push({ name: zipName, data: readFileSync(src) });
    console.log(`  + ${zipName} (${(statSync(src).size / 1024 / 1024).toFixed(1)} MB)`);
    return true;
  }
  return false;
}

console.log("Building portable release...");
const entries = [];

addIfExists(entries, `luwak-desktop${EXT}`, `luwak-desktop${EXT}`);
addIfExists(entries, `luwak_desktop_lib${DLL_EXT}`, `luwak_desktop_lib${DLL_EXT}`);
addIfExists(entries, `luwak${EXT}`, `luwak${EXT}`);

const iconSrc = join(root, "src-tauri", "icons", "icon.png");
if (existsSync(iconSrc)) {
  entries.push({ name: "icon.png", data: readFileSync(iconSrc) });
  console.log(`  + icon.png`);
}

const exampleConfig = join(root, "luwak.yaml.example");
if (existsSync(exampleConfig)) {
  entries.push({ name: "luwak.yaml.example", data: readFileSync(exampleConfig) });
  console.log(`  + luwak.yaml.example`);
}

if (entries.length === 0) {
  console.error("No files found. Run `cargo tauri build` first.");
  process.exit(1);
}

await makeZip(entries, outDir);
console.log("Done.");
