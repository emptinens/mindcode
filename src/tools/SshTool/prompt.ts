export const SSH_TOOL_NAME = 'Ssh'

export function getSshPrompt(): string {
  return `Open and drive persistent SSH sessions to remote hosts. The connection
stays alive across calls, and an interactive remote shell keeps its state
(working directory, environment, running programs) between reads/writes — just
like a real ssh login.

Action-based. Every call passes an "action":

- open   Connect to a host. You MUST pass "sessionId" — a short, descriptive
         NAME you choose for this connection (e.g. "prod", "db-box"), not a
         random string; reuse it on every following call. Provide host, username,
         and auth. Auth options:
           password:        password authentication
           privateKey:      inline private key text (PEM/OpenSSH)
           privateKeyPath:  path to a private key file on this machine
           passphrase:      passphrase for an encrypted key
           agent:           ssh-agent socket path (or "pageant" on Windows)
         By default an interactive shell channel is opened too. Host keys are
         accepted automatically (trust-on-first-use).
- write  Type input into the interactive shell. Commands are submitted for you
         (Enter is appended). Send control chars directly, e.g. "\\u0003" for
         Ctrl-C. Do not append a literal "\\n" — it types as backslash-n.
- read   Drain remote shell output since your last read. Smart-blocking: waits
         until output settles (settleMs) or your "until" regex matches, capped
         by timeoutMs. Loop: write a command, then read.
- exec   Run a single command on its own channel and return stdout, stderr, and
         exit code. Does NOT share the interactive shell's state — use it for
         quick one-offs where you just want the result.
- list   Show active SSH sessions.
- close  Disconnect and free a session.

Usage notes:
- "open" once, then reuse the sessionId. Don't reconnect per command.
- Use "write"+"read" for interactive/stateful work (sudo prompts, REPLs, cd
  that must persist). Use "exec" for independent one-shot commands.
- For file transfer over the same connection, use the Sftp tool with this
  sessionId.
- Output buffer is bounded (~256 KB); oldest bytes drop on overflow
  ("truncated": true).`
}
