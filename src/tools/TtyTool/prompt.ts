export const TTY_TOOL_NAME = 'Tty'

export function getTtyPrompt(): string {
  return `Start and drive a real, persistent local terminal (PTY) session — like a
cmd/bash window that keeps its state (working directory, environment variables,
and any running REPLs or interactive programs) between calls.

Unlike Bash, which runs one command and returns, a Tty session is a live
terminal you interact with over multiple calls. Use it for interactive programs
(REPLs, ssh clients, ncurses/TUI apps, prompts that ask for input), for
workflows where shell state must persist, or when you need to send control
keys (Ctrl-C, arrows, tab-completion).

This tool is action-based. Every call passes an "action":

- open   Spawn a new terminal. You MUST pass "sessionId" — a short, descriptive
         NAME you choose for this session (e.g. "build", "server", "repl"), not
         a random string. Reuse that same name on every following call. Optional:
         shell, cwd, env, cols, rows.
- write  Type text into the session. To RUN a command, just put the command in
         "data" — Enter is appended for you (enter defaults to true; the correct
         terminator is used per-platform, incl. cmd.exe on Windows). Do NOT try
         to append a newline yourself: a "\\n" in JSON is typed as the literal
         characters backslash-n and will not submit. To type WITHOUT submitting
         (answering an interactive prompt key-by-key, or sending only control
         chars), set enter:false. Send control chars directly in data: "\\u0003"
         for Ctrl-C, "\\u001b[A" for up-arrow, "\\t" for tab.
- read   Drain output produced since your last read. This BLOCKS smartly:
         it waits until output goes quiet (settleMs) or until your "until"
         regex matches (e.g. a shell prompt like "\\$ $" or ">>> "), capped by
         timeoutMs. Typical loop: write a command, then read.
- list   Show all active sessions with pid, cwd, status, and pending bytes.
- close  Kill a session and free it.

Usage notes:
- Always "open" before "write"/"read". Reuse the same sessionId; do not open a
  new session per command.
- Output is returned only once (each read drains the buffer). Read after every
  write so you don't miss prompts.
- For a command whose completion you can detect, pass "until" with a regex for
  the prompt to return as soon as it reappears, instead of waiting the full
  settle window.
- The per-session output buffer is bounded (~256 KB); very chatty processes
  will have their oldest output dropped ("truncated": true).
- Sessions persist across calls until you "close" them or the process exits.`
}
