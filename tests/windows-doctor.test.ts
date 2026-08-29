import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const doctorPath = resolve("诊断小蛇-Windows.ps1");

describe("Windows readiness doctor", () => {
  it("is read-only and covers the Windows handoff/runtime gates", async () => {
    const doctor = await readFile(doctorPath, "utf8");
    expect(doctor).toContain("xiaoshe-windows-doctor/v1");
    expect(doctor).toContain("/xiaoshe/desktop/status");
    expect(doctor).toContain("AllowDevelopmentWithoutDevLicense");
    expect(doctor).not.toMatch(/Start-Process|Stop-Process|taskkill/i);
  });

  it.skipIf(process.platform !== "win32")("emits machine-readable diagnostics without starting the service", () => {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", doctorPath, "-Json"], {
      encoding: "utf8",
    });
    expect([0, 1]).toContain(result.status);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ schema: "xiaoshe-windows-doctor/v1", platform: "win32" });
    expect(Array.isArray(report.checks)).toBe(true);
    expect(report.checks.length).toBeGreaterThan(8);
  });
});
