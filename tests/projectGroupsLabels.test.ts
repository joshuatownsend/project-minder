import { describe, it, expect } from "vitest";
import { locationLabels, locationRootLabel } from "@/lib/groups/labels";

describe("locationRootLabel", () => {
  it("names drives, WSL distros, UNC hosts, and POSIX roots", () => {
    expect(locationRootLabel("C:\\dev\\foo")).toBe("C:");
    expect(locationRootLabel("d:/dev/foo")).toBe("D:");
    expect(locationRootLabel("\\\\wsl.localhost\\Ubuntu\\home\\me\\dev\\foo")).toBe("WSL Ubuntu");
    expect(locationRootLabel("//wsl$/Debian/home/me/foo")).toBe("WSL Debian");
    expect(locationRootLabel("\\\\nas\\share\\foo")).toBe("\\\\nas");
    expect(locationRootLabel("/home/me/dev/foo")).toBe("/");
  });
});

describe("locationLabels", () => {
  it("uses the root alone when it distinguishes the members", () => {
    const labels = locationLabels(["C:\\dev\\foo", "\\\\wsl.localhost\\Ubuntu\\home\\me\\dev\\foo"]);
    expect(labels.get("C:\\dev\\foo")).toBe("C:");
    expect(labels.get("\\\\wsl.localhost\\Ubuntu\\home\\me\\dev\\foo")).toBe("WSL Ubuntu");
  });

  it("refines only the members that clash, per pair", () => {
    const labels = locationLabels(["C:\\dev\\foo", "D:\\dev\\foo", "C:\\work\\foo"]);
    expect(labels.get("C:\\dev\\foo")).toBe("C:\\dev");
    expect(labels.get("D:\\dev\\foo")).toBe("D:");
    expect(labels.get("C:\\work\\foo")).toBe("C:\\work");
  });

  it("falls back to the whole path when everything but the leaf agrees", () => {
    const labels = locationLabels(["C:\\dev\\foo", "C:\\dev\\foo-2"]);
    expect(labels.get("C:\\dev\\foo")).toBe("C:\\dev\\foo");
    expect(labels.get("C:\\dev\\foo-2")).toBe("C:\\dev\\foo-2");
  });

  it("distinguishes two distros and two POSIX homes", () => {
    const wsl = locationLabels([
      "\\\\wsl.localhost\\Ubuntu\\home\\me\\dev\\foo",
      "\\\\wsl.localhost\\Debian\\home\\me\\dev\\foo",
    ]);
    expect([...wsl.values()]).toEqual(["WSL Ubuntu", "WSL Debian"]);
    const posix = locationLabels(["/home/me/dev/foo", "/srv/dev/foo"]);
    expect([...posix.values()]).toEqual(["/home", "/srv"]);
  });

  it("refines inside one distro with the distro's own separator", () => {
    const labels = locationLabels([
      "\\\\wsl.localhost\\Ubuntu\\home\\me\\dev\\foo",
      "\\\\wsl.localhost\\Ubuntu\\srv\\foo",
    ]);
    expect([...labels.values()]).toEqual(["WSL Ubuntu:/home", "WSL Ubuntu:/srv"]);
  });

  it("keys on the raw path and preserves input order", () => {
    const paths = ["D:\\x\\foo", "C:\\x\\foo"];
    expect([...locationLabels(paths).keys()]).toEqual(paths);
  });
});
