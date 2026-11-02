import { describe, it, expect } from "vitest";
import { hasHostAccess, HOST_ORIGINS } from "../src/permissions";

describe("permissions", () => {
  it("names both sites the extension needs", () => {
    expect(HOST_ORIGINS).toEqual(["https://www.gradescope.com/*", "https://gatech.instructure.com/*"]);
  });
  it("asks the browser whether both origins are granted", async () => {
    let asked: unknown;
    (globalThis as any).browser = {
      permissions: { contains: async (q: unknown) => { asked = q; return false; } },
    };
    expect(await hasHostAccess()).toBe(false);
    expect(asked).toEqual({ origins: HOST_ORIGINS });
  });
});
