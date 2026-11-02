import { describe, it, expect } from "vitest";
import { GradescopeClient } from "../../src/gradescope/client";
import { SessionExpired } from "../../src/errors";

function fakeFetch(status: number, body: string, finalUrl: string) {
  const calls: string[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    expect(init?.credentials).toBe("include");
    return { ok: status < 400, status, url: finalUrl, text: async () => body } as Response;
  }) as typeof fetch;
  return { fn, calls };
}

describe("GradescopeClient", () => {
  it("returns the account page html", async () => {
    const f = fakeFetch(200, "<html>acct</html>", "https://www.gradescope.com/account");
    expect(await new GradescopeClient(f.fn).fetchAccount()).toBe("<html>acct</html>");
    expect(f.calls[0]).toBe("https://www.gradescope.com/account");
  });
  it("returns a course page html", async () => {
    const f = fakeFetch(200, "<html>c</html>", "https://www.gradescope.com/courses/111");
    expect(await new GradescopeClient(f.fn).fetchCourse("111")).toBe("<html>c</html>");
    expect(f.calls[0]).toBe("https://www.gradescope.com/courses/111");
  });
  it("throws SessionExpired when redirected away from the requested path", async () => {
    const f = fakeFetch(200, "<html>login</html>", "https://www.gradescope.com/login");
    await expect(new GradescopeClient(f.fn).fetchAccount()).rejects.toBeInstanceOf(SessionExpired);
  });
  it("throws SessionExpired on 401", async () => {
    const f = fakeFetch(401, "", "https://www.gradescope.com/account");
    await expect(new GradescopeClient(f.fn).fetchAccount()).rejects.toBeInstanceOf(SessionExpired);
  });
  it("throws a plain Error on 500", async () => {
    const f = fakeFetch(500, "", "https://www.gradescope.com/account");
    await expect(new GradescopeClient(f.fn).fetchAccount()).rejects.toThrow(/500/);
  });
});
