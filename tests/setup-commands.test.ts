import { describe, expect, it } from 'vitest';
import { setupCommands } from '../src/setup-commands';

describe('platform-specific GitHub setup', () => {
  it('uses PowerShell literal paths on Windows', () => {
    const commands = setupCommands('windows', "C:\\Diaries\\Aditya's diary", 'person/private-diary');
    expect(commands.create).toContain("Set-Location -LiteralPath 'C:\\Diaries\\Aditya''s diary'");
    expect(commands.create).toContain('gh repo create person/private-diary --private');
    expect(commands.restore).toContain('"$HOME\\Documents\\Restored Diary"');
  });
  it('uses safely quoted POSIX paths on Linux', () => {
    const commands = setupCommands('linux', "/home/test/A diary's $HOME", 'person/private-diary');
    expect(commands.create).toContain("cd -- '/home/test/A diary'\\''s $HOME'");
    expect(commands.create).not.toContain('Set-Location');
    expect(commands.restore).toContain('"$HOME/Restored-Diary"');
    expect(commands.shellName).toBe('Terminal');
  });
});
