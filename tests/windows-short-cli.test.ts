import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const WINDOWS_POWERSHELL = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const CMD = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
const INSTALLER = resolve("scripts/install-windows-cli.ps1");
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe.runIf(process.platform === "win32")("Windows short CLI", () => {
  it("runs installed commands without pwsh on PATH", async () => {
    const fakeRoot = await mkdtemp(join(tmpdir(), "xiaoshe-cli-root-"));
    const bin = await mkdtemp(join(tmpdir(), "xiaoshe-cli-bin-"));
    temporary.push(fakeRoot, bin);
    const scripts = join(fakeRoot, "scripts");
    await mkdir(scripts);
    await writeFile(
      join(scripts, "windows-start-entry.ps1"),
      "param([switch]$NoOpen) Write-Output ('START noOpen=' + $NoOpen); exit 0\r\n",
      "ascii",
    );
    await writeFile(
      join(scripts, "windows-doctor-entry.ps1"),
      "param([switch]$Json) Write-Output ('DOCTOR json=' + $Json); exit 0\r\n",
      "ascii",
    );

    const installed = spawnSync(WINDOWS_POWERSHELL, [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", INSTALLER,
      "-XsRoot", fakeRoot,
      "-BinPath", bin,
      "-NoPathUpdate",
    ], { encoding: "utf8" });
    expect(installed.status, installed.stderr).toBe(0);

    const envWithoutPwsh = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
    );
    envWithoutPwsh.Path = "";
    const started = spawnSync(CMD, ["/d", "/c", join(bin, "s.cmd"), "-NoOpen"], {
      encoding: "utf8",
      env: envWithoutPwsh,
    });
    expect(started.status, started.stderr).toBe(0);
    expect(started.stdout).toContain("START noOpen=True");

    const diagnosed = spawnSync(CMD, ["/d", "/c", join(bin, "xiaoshe-doctor.cmd"), "-Json"], {
      encoding: "utf8",
      env: envWithoutPwsh,
    });
    expect(diagnosed.status, diagnosed.stderr).toBe(0);
    expect(diagnosed.stdout).toContain("DOCTOR json=True");
  });

  it("ships visible Windows launchers beside the PowerShell scripts", async () => {
    const launchers = await Promise.all([
      readFile(resolve("启动小蛇-Windows.cmd"), "utf8"),
      readFile(resolve("停止小蛇-Windows.cmd"), "utf8"),
      readFile(resolve("诊断小蛇-Windows.cmd"), "utf8"),
    ]);
    expect(launchers.every(content => content.includes("WindowsPowerShell\\v1.0\\powershell.exe"))).toBe(true);
  });
});
