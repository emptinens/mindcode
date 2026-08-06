import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  ensureTaskGraphPaths,
  getTaskGraphPaths,
  resolveMindCodeConfigDir,
  secureTaskGraphDatabaseFiles,
} from "./taskGraphPaths.js";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join("/tmp", "mindcode-paths-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("TaskGraph path parity", () => {
  test("expands tilde and resolves relative config directories from cwd", () => {
    expect(resolveMindCodeConfigDir({ MINDCODE_CONFIG_DIR: "~" })).toBe(
      homedir(),
    );
    expect(
      resolveMindCodeConfigDir({
        MINDCODE_CONFIG_DIR: "  ~/custom/../mindcode  ",
      }),
    ).toBe(join(homedir(), "mindcode"));

    const relative = "./.tmp-mindcode/../mindcode-relative";
    expect(resolveMindCodeConfigDir({ MINDCODE_CONFIG_DIR: relative })).toBe(
      resolve(process.cwd(), relative),
    );
    expect(getTaskGraphPaths({ MINDCODE_CONFIG_DIR: relative }).stateDir).toBe(
      join(resolve(process.cwd(), relative), "state"),
    );
  });

  test("creates all fallback state directories with mode 0700", () => {
    const configDir = join(temporaryRoot(), "config");
    const paths = ensureTaskGraphPaths({ MINDCODE_CONFIG_DIR: configDir });

    for (const path of [paths.stateDir, paths.reportsDir, paths.runsDir]) {
      const metadata = lstatSync(path);
      expect(metadata.isDirectory()).toBe(true);
      expect(metadata.isSymbolicLink()).toBe(false);
      expect(metadata.mode & 0o777).toBe(0o700);
    }
  });

  test("hardens the database and WAL/SHM sidecars to mode 0600", () => {
    const stateDir = join(temporaryRoot(), "database-state");
    ensureTaskGraphPaths({ MINDCODE_CONFIG_DIR: stateDir });
    const path = join(stateDir, "state", "tasks.db");
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      writeFileSync(candidate, "fixture");
      chmodSync(candidate, 0o644);
    }

    secureTaskGraphDatabaseFiles(path);

    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      expect(lstatSync(candidate).mode & 0o777).toBe(0o600);
    }
  });
});
