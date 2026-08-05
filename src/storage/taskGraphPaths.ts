import { mkdirSync } from "node:fs";
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
  mkdirSync(paths.stateDir, { recursive: true });
  mkdirSync(paths.reportsDir, { recursive: true });
  mkdirSync(paths.runsDir, { recursive: true });
  return paths;
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
