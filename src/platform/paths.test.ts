import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const envBackup = { ...process.env };

describe('platform path candidates', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...envBackup };
  });

  afterEach(() => {
    process.env = { ...envBackup };
    vi.unstubAllGlobals();
  });

  it('includes XDG candidates for pi on linux', async () => {
    process.env.XDG_CONFIG_HOME = '/home/test/.config';
    process.env.XDG_DATA_HOME = '/home/test/.local/share';
    vi.stubGlobal('process', { ...process, platform: 'linux', env: process.env });
    const mod = await import('./paths.js');
    const candidates = mod.candidatePiRoots();
    expect(candidates).toContain('/home/test/.config/pi/agent/sessions');
    expect(candidates).toContain('/home/test/.local/share/pi/agent/sessions');
  });

  it('includes Application Support candidates for codex on macOS', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin', env: process.env });
    const mod = await import('./paths.js');
    const candidates = mod.candidateCodexRoots();
    expect(candidates.some((value) => value.includes('Library/Application Support/Codex/sessions'))).toBe(true);
  });

  it('includes APPDATA and LOCALAPPDATA candidates for claude on Windows', async () => {
    process.env.APPDATA = 'C:/Users/test/AppData/Roaming';
    process.env.LOCALAPPDATA = 'C:/Users/test/AppData/Local';
    vi.stubGlobal('process', { ...process, platform: 'win32', env: process.env });
    const mod = await import('./paths.js');
    const candidates = mod.candidateClaudeRoots();
    expect(candidates).toContain('C:/Users/test/AppData/Roaming/Claude/projects');
    expect(candidates).toContain('C:/Users/test/AppData/Local/Claude/projects');
  });
});
