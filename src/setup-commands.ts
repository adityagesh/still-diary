import type { DesktopPlatform } from '../shared/types';

export function setupCommands(platform: DesktopPlatform, folder: string, repository: string) {
  const windows = platform === 'windows';
  const quotedFolder = windows ? `'${folder.replaceAll("'", "''")}'` : `'${folder.replaceAll("'", "'\\''")}'`;
  return {
    shellName: windows ? 'PowerShell' : 'Terminal',
    openShell: windows ? 'Open PowerShell from the Windows Start menu.' : 'Open a terminal on your computer.',
    auth: 'gh auth login --hostname github.com --git-protocol ssh --web\nssh -T git@github.com',
    create: `${windows ? 'Set-Location -LiteralPath' : 'cd --'} ${quotedFolder}\ngit init --initial-branch=main\ngh repo create ${repository} --private --source . --remote origin`,
    restore: `git clone git@github.com:${repository}.git ${windows ? '"$HOME\\Documents\\Restored Diary"' : '"$HOME/Restored-Diary"'}`,
    restoredFolder: windows ? 'Restored Diary' : 'Restored-Diary',
  };
}
