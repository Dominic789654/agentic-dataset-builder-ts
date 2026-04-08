import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

function currentPlatform(): NodeJS.Platform {
  return process.platform;
}

function xdgConfigHome(): string | undefined {
  return process.env.XDG_CONFIG_HOME;
}

function xdgDataHome(): string | undefined {
  return process.env.XDG_DATA_HOME;
}

function macAppSupportHome(): string | undefined {
  if (currentPlatform() !== 'darwin') return undefined;
  return path.join(os.homedir(), 'Library', 'Application Support');
}

export function candidatePiRoots(): string[] {
  const home = os.homedir();
  const appdata = process.env.APPDATA;
  const localappdata = process.env.LOCALAPPDATA;
  const xdgConfig = xdgConfigHome();
  const xdgData = xdgDataHome();
  const macAppSupport = macAppSupportHome();
  return dedupe([
    process.env.PI_SESSION_ROOT,
    path.join(home, '.pi', 'agent', 'sessions'),
    xdgConfig ? path.join(xdgConfig, 'pi', 'agent', 'sessions') : undefined,
    xdgConfig ? path.join(xdgConfig, '.pi', 'agent', 'sessions') : undefined,
    xdgData ? path.join(xdgData, 'pi', 'agent', 'sessions') : undefined,
    xdgData ? path.join(xdgData, '.pi', 'agent', 'sessions') : undefined,
    macAppSupport ? path.join(macAppSupport, 'pi', 'agent', 'sessions') : undefined,
    macAppSupport ? path.join(macAppSupport, '.pi', 'agent', 'sessions') : undefined,
    appdata ? path.join(appdata, 'pi', 'agent', 'sessions') : undefined,
    appdata ? path.join(appdata, '.pi', 'agent', 'sessions') : undefined,
    localappdata ? path.join(localappdata, 'pi', 'agent', 'sessions') : undefined,
    localappdata ? path.join(localappdata, '.pi', 'agent', 'sessions') : undefined,
  ]);
}

export function candidateCodexRoots(): string[] {
  const home = os.homedir();
  const appdata = process.env.APPDATA;
  const localappdata = process.env.LOCALAPPDATA;
  const xdgConfig = xdgConfigHome();
  const xdgData = xdgDataHome();
  const macAppSupport = macAppSupportHome();
  return dedupe([
    process.env.CODEX_SESSION_ROOT,
    path.join(home, '.codex', 'sessions'),
    xdgConfig ? path.join(xdgConfig, 'codex', 'sessions') : undefined,
    xdgConfig ? path.join(xdgConfig, '.codex', 'sessions') : undefined,
    xdgData ? path.join(xdgData, 'codex', 'sessions') : undefined,
    xdgData ? path.join(xdgData, '.codex', 'sessions') : undefined,
    macAppSupport ? path.join(macAppSupport, 'Codex', 'sessions') : undefined,
    macAppSupport ? path.join(macAppSupport, '.codex', 'sessions') : undefined,
    appdata ? path.join(appdata, 'Codex', 'sessions') : undefined,
    appdata ? path.join(appdata, '.codex', 'sessions') : undefined,
    localappdata ? path.join(localappdata, 'Codex', 'sessions') : undefined,
    localappdata ? path.join(localappdata, '.codex', 'sessions') : undefined,
  ]);
}

export function candidateClaudeRoots(): string[] {
  const home = os.homedir();
  const appdata = process.env.APPDATA;
  const localappdata = process.env.LOCALAPPDATA;
  const xdgConfig = xdgConfigHome();
  const xdgData = xdgDataHome();
  const macAppSupport = macAppSupportHome();
  return dedupe([
    process.env.CLAUDE_SESSION_ROOT,
    path.join(home, '.claude', 'projects'),
    xdgConfig ? path.join(xdgConfig, 'claude', 'projects') : undefined,
    xdgConfig ? path.join(xdgConfig, '.claude', 'projects') : undefined,
    xdgData ? path.join(xdgData, 'claude', 'projects') : undefined,
    xdgData ? path.join(xdgData, '.claude', 'projects') : undefined,
    macAppSupport ? path.join(macAppSupport, 'Claude', 'projects') : undefined,
    macAppSupport ? path.join(macAppSupport, '.claude', 'projects') : undefined,
    appdata ? path.join(appdata, 'Claude', 'projects') : undefined,
    appdata ? path.join(appdata, '.claude', 'projects') : undefined,
    localappdata ? path.join(localappdata, 'Claude', 'projects') : undefined,
    localappdata ? path.join(localappdata, '.claude', 'projects') : undefined,
  ]);
}

export function firstExisting(candidates: string[]): string {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return path.resolve(candidate);
  }
  return path.resolve(candidates[0]);
}

function dedupe(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}
