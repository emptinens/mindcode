import {
  type Stats,
  chmodSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export const DEFAULT_MINDCODE_CONFIG_DIR = join(homedir(), ".mindcode");

export interface TaskGraphPaths {
  configDir: string;
  stateDir: string;
  databasePath: string;
  tasksDb: string;
  mailboxDatabasePath: string;
  mailboxDb: string;
  reportsDir: string;
  runsDir: string;
}

export type TaskGraphEnvironment = {
  MINDCODE_CONFIG_DIR?: string;
  [key: string]: string | undefined;
};

function expandConfigDir(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

export function resolveMindCodeConfigDir(
  environment: TaskGraphEnvironment = process.env,
): string {
  const configured = environment.MINDCODE_CONFIG_DIR?.trim();
  if (!configured) {
    return DEFAULT_MINDCODE_CONFIG_DIR;
  }

  const expanded = expandConfigDir(configured);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function getTaskGraphPaths(
  environment: TaskGraphEnvironment = process.env,
): TaskGraphPaths {
  const configDir = resolveMindCodeConfigDir(environment);
  const stateDir = join(configDir, "state");
  const databasePath = join(stateDir, "tasks.db");
  const mailboxDatabasePath = join(stateDir, "mailbox.db");
  const reportsDir = join(stateDir, "reports");
  const runsDir = join(stateDir, "runs");

  return {
    configDir,
    stateDir,
    databasePath,
    tasksDb: databasePath,
    mailboxDatabasePath,
    mailboxDb: mailboxDatabasePath,
    reportsDir,
    runsDir,
  };
}

export function ensureTaskGraphPaths(
  environment: TaskGraphEnvironment = process.env,
): TaskGraphPaths {
  const paths = getTaskGraphPaths(environment);
  ensurePrivateDirectory(paths.stateDir);
  ensurePrivateDirectory(paths.reportsDir);
  ensurePrivateDirectory(paths.runsDir);
  return paths;
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Task graph path is not a private directory: ${path}`);
  }
  assertCurrentUserOwnership(metadata, path, "directory");
  chmodSync(path, 0o700);
  const verified = lstatSync(path);
  if (
    !verified.isDirectory() ||
    verified.isSymbolicLink() ||
    !isCurrentUserOwner(verified) ||
    (verified.mode & 0o777) !== 0o700
  ) {
    throw new Error(`Task graph directory permissions are not 0700: ${path}`);
  }
}

/** Enforce private SQLite database and WAL/SHM sidecar permissions. */
export function secureTaskGraphDatabaseFiles(databasePath: string): void {
  if (databasePath === ":memory:") return;
  for (const candidate of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ]) {
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      const target = metadata.isSymbolicLink() ? readlinkSync(candidate) : "";
      throw new Error(
        `Task graph database sidecar is not a regular file: ${candidate}${target ? ` -> ${target}` : ""}`,
      );
    }
    assertCurrentUserOwnership(metadata, candidate, "database file");
    chmodSync(candidate, 0o600);
    const verified = lstatSync(candidate);
    if (
      verified.isSymbolicLink() ||
      !verified.isFile() ||
      !isCurrentUserOwner(verified) ||
      (verified.mode & 0o777) !== 0o600
    ) {
      throw new Error(
        `Task graph database permissions are not 0600: ${candidate}`,
      );
    }
  }
}

function isCurrentUserOwner(metadata: Stats): boolean {
  const uid = process.getuid?.();
  return uid === undefined || metadata.uid === uid;
}

function assertCurrentUserOwnership(
  metadata: Stats,
  path: string,
  kind: string,
): void {
  if (!isCurrentUserOwner(metadata)) {
    throw new Error(
      `Task graph ${kind} is not owned by the current user: ${path}`,
    );
  }
}

export const getTaskGraphDatabasePath = (
  environment: TaskGraphEnvironment = process.env,
): string => getTaskGraphPaths(environment).databasePath;

export const getTaskGraphDbPath = getTaskGraphDatabasePath;
export const resolveTaskGraphDatabasePath = getTaskGraphDatabasePath;
export const taskGraphDbPath = getTaskGraphDatabasePath;

export const getMailboxDatabasePath = (
  environment: TaskGraphEnvironment = process.env,
): string => getTaskGraphPaths(environment).mailboxDatabasePath;

export const getReportsDirectory = (
  environment: TaskGraphEnvironment = process.env,
): string => getTaskGraphPaths(environment).reportsDir;

export const getRunsDirectory = (
  environment: TaskGraphEnvironment = process.env,
): string => getTaskGraphPaths(environment).runsDir;
