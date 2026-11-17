// scripts/install.sh end to end against a local release server: download, checksum, install,
// reinstall, and the refusals (bad checksum, a bundle that isn't Peer). Uses a tiny stand-in
// release asset (an ad-hoc signed Peer.app on macOS, a shell "AppImage" on Linux).
import { execFile, execFileSync, spawn } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync, readlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const script = join(__dirname, "..", "scripts", "install.sh");
const version = "9.9.9-test.1";
const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const assetArch = isMac
  ? process.arch === "arm64" ? "mac-arm64" : "mac-x64"
  : process.arch === "arm64" ? "linux-arm64" : "linux-x86_64";
const asset = `Peer-${version}-${assetArch}.${isMac ? "zip" : "AppImage"}`;

let root: string;
let www: string;
let server: Server;
let base: string;

function writeSums(content?: string) {
  const dir = join(www, `v${version}`);
  const hash = createHash("sha256").update(readFileSync(join(dir, asset))).digest("hex");
  writeFileSync(join(dir, "SHA256SUMS.txt"), content ?? `${hash}  ${asset}\n`);
}

function makeMacApp(dir: string, bundleId: string) {
  const app = join(dir, "Peer.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleExecutable</key><string>Peer</string></dict></plist>`,
  );
  writeFileSync(join(app, "Contents", "MacOS", "Peer"), "#!/bin/sh\necho stand-in\n");
  chmodSync(join(app, "Contents", "MacOS", "Peer"), 0o755);
  return app;
}

function run(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("sh", [script], { env: { ...process.env, PEER_DOWNLOAD_BASE: base, PEER_VERSION: version, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` });
    });
  });
}

describe.runIf(isMac || isLinux)("scripts/install.sh", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "peer-install-test-"));
    www = join(root, "www");
    const dir = join(www, `v${version}`);
    mkdirSync(dir, { recursive: true });
    if (isMac) {
      const build = join(root, "build");
      mkdirSync(build);
      const app = makeMacApp(build, "dev.peer.app");
      execFileSync("codesign", ["--force", "--deep", "-s", "-", app]);
      execFileSync("ditto", ["-c", "-k", "--keepParent", app, join(dir, asset)]);
    } else {
      // Like the real AppImage: `--appimage-extract <path>` unpacks that file into ./squashfs-root.
      writeFileSync(
        join(dir, asset),
        [
          "#!/bin/sh",
          'if [ "$1" = --appimage-extract ]; then',
          '  case "$2" in */512x512/*) mkdir -p "squashfs-root/$(dirname "$2")" && printf PNG-STAND-IN > "squashfs-root/$2" ;; esac',
          "  exit 0",
          "fi",
          'echo stand-in "$@"',
          "",
        ].join("\n"),
      );
    }
    writeSums();
    server = createServer((req, res) => {
      const file = join(www, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
      if (!file.startsWith(www) || !existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200);
      createReadStream(file).pipe(res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  it("installs the verified build, and reinstalls over it", async () => {
    const home = join(root, "home-ok");
    const dest = join(root, "apps-ok");
    mkdirSync(home, { recursive: true });
    const env = { HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), PEER_INSTALL_DIR: dest };
    for (const attempt of [1, 2]) {
      const r = await run(env);
      expect(r.out, `attempt ${attempt}`).toContain("Checksum OK.");
      expect(r.code, r.out).toBe(0);
    }
    if (isMac) {
      expect(existsSync(join(dest, "Peer.app", "Contents", "MacOS", "Peer"))).toBe(true);
      execFileSync("codesign", ["--verify", "--deep", "--strict", join(dest, "Peer.app")]);
    } else {
      const image = join(dest, "Peer.AppImage");
      expect(execFileSync(image, ["--hi"]).toString()).toContain("stand-in --hi");
      expect(readlinkSync(join(home, ".local", "bin", "peer"))).toBe(image);
      const desktop = readFileSync(join(home, ".local", "share", "applications", "peer.desktop"), "utf8");
      expect(desktop).toContain(`Exec="${image}"`);
      expect(desktop).toMatch(/^StartupWMClass=peer$/m);
      expect(desktop).toMatch(/^Icon=peer$/m);
      expect(readFileSync(join(home, ".local", "share", "icons", "hicolor", "512x512", "apps", "peer.png"), "utf8")).toBe("PNG-STAND-IN");
    }
  });

  it("refuses a download whose checksum doesn't match, and installs nothing", async () => {
    const home = join(root, "home-bad");
    const dest = join(root, "apps-bad");
    mkdirSync(home, { recursive: true });
    writeSums(`${"0".repeat(64)}  ${asset}\n`);
    try {
      const r = await run({ HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), PEER_INSTALL_DIR: dest });
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toContain("Checksum mismatch");
      expect(existsSync(join(dest, isMac ? "Peer.app" : "Peer.AppImage"))).toBe(false);
    } finally {
      writeSums();
    }
  });

  it("refuses a release with no checksum entry for this build", async () => {
    writeSums(`${"0".repeat(64)}  Peer-${version}-other.zip\n`);
    try {
      const r = await run({ HOME: join(root, "home-none"), PEER_INSTALL_DIR: join(root, "apps-none") });
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toContain("has no entry");
    } finally {
      writeSums();
    }
  });

  it.runIf(isMac)("never replaces an app at the destination that isn't Peer", async () => {
    const dest = join(root, "apps-other");
    mkdirSync(dest, { recursive: true });
    makeMacApp(dest, "com.example.other");
    const r = await run({ PEER_INSTALL_DIR: dest });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("is not Peer");
    expect(readFileSync(join(dest, "Peer.app", "Contents", "Info.plist"), "utf8")).toContain("com.example.other");
  });

  // Regression (verify F1): the running check once used `pgrep -f "$app/…"`, a regex, so a path
  // with parentheses never matched and a running Peer was replaced.
  it.runIf(isMac)("refuses to replace a running Peer, even in a path with regex characters", async () => {
    const dest = join(root, "Applications (Personal) [x]");
    mkdirSync(dest, { recursive: true });
    const app = makeMacApp(dest, "dev.peer.app");
    const exe = join(app, "Contents", "MacOS", "Peer");
    // A real binary, so the process's executable path is exe. macOS kills a copied platform
    // binary outside the system folders unless it is re-signed.
    copyFileSync("/bin/sleep", exe);
    execFileSync("codesign", ["--force", "-s", "-", exe]);
    const child = spawn(exe, ["30"], { stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 300));
      const r = await run({ PEER_INSTALL_DIR: dest });
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toContain("Peer is running");
      expect(child.exitCode).toBeNull(); // the stand-in was really running during the install
      // Still the running binary, not the release's stand-in script.
      expect(readFileSync(exe).subarray(0, 2).toString()).not.toBe("#!");
      expect(readdirSync(dest)).toEqual(["Peer.app"]);
    } finally {
      child.kill();
    }
  });

  // Regression (verify F2): the old bundle was deleted before the new one was in place.
  it.runIf(isMac)("keeps the existing Peer when the new one can't be put in place", async () => {
    const dest = join(root, "apps-readonly");
    mkdirSync(dest, { recursive: true });
    const app = makeMacApp(dest, "dev.peer.app");
    writeFileSync(join(app, "Contents", "marker"), "old install");
    chmodSync(dest, 0o555);
    try {
      const r = await run({ PEER_INSTALL_DIR: dest });
      expect(r.code, r.out).not.toBe(0);
      expect(readFileSync(join(app, "Contents", "marker"), "utf8")).toBe("old install");
      expect(readdirSync(dest)).toEqual(["Peer.app"]);
    } finally {
      chmodSync(dest, 0o755);
    }
  });

  it("needs PEER_VERSION with a custom download base", async () => {
    const r = await run({ PEER_VERSION: "" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("PEER_DOWNLOAD_BASE needs PEER_VERSION");
  });
});
