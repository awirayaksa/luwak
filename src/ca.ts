import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

export interface CertResult {
  cert: string;
  key: string;
}

/** Common OpenSSL locations on Windows (GUI apps may not have it in PATH). */
const OPENSSL_SEARCH_PATHS: string[] = [
  "openssl", // PATH (works on macOS/Linux and Windows with proper PATH)
  // Windows: common install locations
  "C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe",
  "C:\\Program Files (x86)\\OpenSSL-Win64\\bin\\openssl.exe",
  "C:\\opt\\OpenSSL-Win64\\bin\\openssl.exe",
  "C:\\OpenSSL-Win64\\bin\\openssl.exe",
  // Git for Windows bundles openssl
  "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
  "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
  // MSYS2
  "C:\\msys64\\usr\\bin\\openssl.exe",
  // winget default
  "C:\\Users\\Public\\OpenSSL-Win64\\bin\\openssl.exe",
];

let resolvedOpenssl: string | null = null;

function findOpenssl(): string {
  if (resolvedOpenssl) return resolvedOpenssl;

  for (const candidate of OPENSSL_SEARCH_PATHS) {
    try {
      const result = spawnSync(candidate, ["version"], { timeout: 5000, encoding: "utf8", stdio: "pipe" });
      if (result.status === 0) {
        resolvedOpenssl = candidate;
        return candidate;
      }
    } catch {
      // try next
    }
  }

  // As a last resort, search for openssl.exe in all PATH entries
  const pathDirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  for (const dir of pathDirs) {
    const exe = join(dir, process.platform === "win32" ? "openssl.exe" : "openssl");
    if (existsSync(exe)) {
      try {
        const result = spawnSync(exe, ["version"], { timeout: 5000, encoding: "utf8", stdio: "pipe" });
        if (result.status === 0) {
          resolvedOpenssl = exe;
          return exe;
        }
      } catch {
        // try next
      }
    }
  }

  throw new Error(
    "luwak: openssl not found. Install OpenSSL or add it to your PATH.\n" +
    "  Windows:  winget install OpenSSL.OpenSSL\n" +
    "  macOS:    brew install openssl\n" +
    "  Linux:    apt install openssl (or your distro's equivalent)"
  );
}

function openssl(args: string[]): void {
  const exe = findOpenssl();
  const result = spawnSync(exe, args, { timeout: 30000, encoding: "utf8", stderr: "pipe" });
  if (result.error) {
    throw new Error(`luwak: openssl failed to run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`luwak: openssl ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

export class CertificateAuthority {
  private caCert: string;
  private caKey: string;
  private cache = new Map<string, CertResult>();
  private workDir: string;

  constructor(caCertPath: string, caKeyPath: string) {
    if (existsSync(caCertPath) && existsSync(caKeyPath)) {
      this.caCert = readFileSync(caCertPath, "utf8");
      this.caKey = readFileSync(caKeyPath, "utf8");
    } else {
      const dir = dirname(caCertPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      console.log(`luwak: generating CA certificate at ${caCertPath}`);
      this.generateCA(caCertPath, caKeyPath);
      this.caCert = readFileSync(caCertPath, "utf8");
      this.caKey = readFileSync(caKeyPath, "utf8");
    }
    this.workDir = join(tmpdir(), "luwak-certs-" + process.pid.toString());
    if (!existsSync(this.workDir)) mkdirSync(this.workDir, { recursive: true });
  }

  private generateCA(certPath: string, keyPath: string): void {
    openssl(["genrsa", "-out", keyPath, "2048"]);
    openssl([
      "req", "-new", "-x509", "-key", keyPath, "-out", certPath,
      "-days", "3650", "-subj", "/CN=Luwak Proxy CA/O=Luwak",
    ]);
  }

  getCertForHost(hostname: string): CertResult {
    const cached = this.cache.get(hostname);
    if (cached) return cached;

    const keyPath = join(this.workDir, `${hostname}.key`);
    const csrPath = join(this.workDir, `${hostname}.csr`);
    const certPath = join(this.workDir, `${hostname}.crt`);
    const sanPath = join(this.workDir, `${hostname}.san`);
    const caKeyPath = join(this.workDir, "ca.key");
    const caCertPath = join(this.workDir, "ca.crt");

    writeFileSync(caKeyPath, this.caKey);
    writeFileSync(caCertPath, this.caCert);

    openssl(["genrsa", "-out", keyPath, "2048"]);
    openssl(["req", "-new", "-key", keyPath, "-out", csrPath, "-subj", `/CN=${hostname}`]);
    writeFileSync(sanPath, `subjectAltName = DNS:${hostname}\n`);
    openssl([
      "x509", "-req", "-in", csrPath, "-CA", caCertPath, "-CAkey", caKeyPath,
      "-CAcreateserial", "-out", certPath, "-days", "365", "-extfile", sanPath,
    ]);

    const result: CertResult = {
      cert: readFileSync(certPath, "utf8"),
      key: readFileSync(keyPath, "utf8"),
    };
    this.cache.set(hostname, result);
    return result;
  }

  getCACert(): string {
    return this.caCert;
  }

  getCACertPath(): string {
    return this.workDir + "/ca-export.crt";
  }

  exportCACert(): string {
    const path = this.getCACertPath();
    writeFileSync(path, this.caCert);
    return path;
  }
}
