export const SFTP_TOOL_NAME = 'Sftp'

export function getSftpPrompt(): string {
  return `Transfer files and manage remote paths over SFTP, riding on an existing
SSH session opened with the Ssh tool. Open an SSH session first, then pass its
sessionId here. The SFTP subsystem is opened over the same connection (no
second login).

Action-based. Every call passes an "action" and a "sessionId":

- upload    Copy a local file to the remote host. Params: localPath, remotePath.
- download  Copy a remote file to the local machine. Params: remotePath, localPath.
- list      List a remote directory. Param: remotePath. Returns names, sizes,
            and whether each entry is a directory.
- mkdir     Create a remote directory. Param: remotePath.
- remove    Delete a remote file. Param: remotePath.

Usage notes:
- Always open an Ssh session first and reuse its sessionId here.
- Paths are on the machine you'd expect: localPath is on THIS machine,
  remotePath is on the SSH host.
- upload/remove modify the remote host; remove is irreversible.
- Large transfers use parallel reads/writes (fastPut/fastGet) for throughput.`
}
