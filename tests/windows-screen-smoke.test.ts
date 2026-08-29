import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve("scripts/run-windows-screen-smoke.ps1");

describe("Windows screen acceptance harness", () => {
  it("uses a dedicated synthetic UI and never targets unrelated applications", async () => {
    const source = await readFile(scriptPath, "utf8");

    expect(source).toContain("Xiaoshe Windows Acceptance");
    expect(source).toContain("XIAOSHE_SAFE_BUTTON");
    expect(source).toContain("XIAOSHE_FOCUS_INPUT");
    expect(source).toContain("XIAOSHE_SAFE_INPUT");
    expect(source).toContain("XIAOSHE_SAFE_STATUS");
    expect(source).toContain("SetProcessDpiAwarenessContext");
    expect(source).toContain("ConvertTo-Json");
    expect(source).toContain("cleanup");
    expect(source).not.toMatch(/notepad|calculator|Get-Process\s+-Name/i);
  });
});
