//! Dependency-free seccomp (cBPF) denylist for the bwrap sandbox (§13.1).
//!
//! The sandbox already isolates files, credentials, network, PIDs, and
//! resource use; this module adds the syscall layer without pulling in
//! `libseccomp`: a small classic-BPF program is assembled by hand, written to
//! an anonymous `memfd`, and handed to `bwrap --seccomp <fd>`. The policy is a
//! **denylist**, not an allowlist — the sandboxed command still needs the full
//! surface of a normal build (fork/exec/mmap/…), so only the syscalls that can
//! escape isolation or mutate host-global state are refused with `EPERM`.
//! Everything else is allowed.

use crate::{CoreToolError, CoreToolErrorCode, CoreToolResult};
use std::io::{Seek, SeekFrom, Write};
use std::os::fd::{FromRawFd, OwnedFd};

// Classic BPF instruction classes (linux/filter.h). The `code` field packs
// op (3 bits) | size (2 bits) | mode (5 bits); the constants below are the
// pre-combined `BPF_STMT`/`BPF_JUMP` opcodes we use.
const BPF_LD_W_ABS: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
const BPF_JMP_JEQ_K: u16 = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
const BPF_RET_K: u16 = 0x06; // BPF_RET | BPF_K

// Offsets of `struct seccomp_data` (kernel/seccomp.h, x86_64).
const SECCOMP_DATA_NR_OFFSET: u32 = 0;
const SECCOMP_DATA_ARCH_OFFSET: u32 = 4;

// EM_X86_64 | __AUDIT_ARCH_64BIT | __AUDIT_ARCH_LE.
const AUDIT_ARCH_X86_64: u32 = 0xC000_003E;

// SECCOMP_RET values.
const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
const SECCOMP_RET_ALLOW: u32 = 0x7FFF_0000;
const EPERM: u32 = 1;

/// Syscalls refused inside the sandbox (x86_64 numbers, asm/unistd_64.h).
///
/// Grouped by the threat they close:
/// - namespace/mount escape: mount, umount2, pivot_root, chroot, setns, unshare,
///   swapon, swapoff, quotactl, vhangup
/// - module/kexec/reboot: init_module, finit_module, delete_module, kexec_load,
///   kexec_file_load, reboot, acct, iopl, ioperm
/// - cross-process memory & tracing: ptrace, process_vm_readv, process_vm_writev
/// - kernel attack surface: bpf, perf_event_open, userfaultfd, open_by_handle_at,
///   name_to_handle_at
/// - keyring abuse: add_key, request_key, keyctl
/// - host-global state that namespaces do NOT isolate: settimeofday, adjtimex,
///   clock_settime, clock_adjtime, sethostname, setdomainname
const DENIED_SYSCALLS: &[u32] = &[
    101, // ptrace
    153, // vhangup
    155, // pivot_root
    159, // adjtimex
    161, // chroot
    163, // acct
    164, // settimeofday
    165, // mount
    166, // umount2
    167, // swapon
    168, // swapoff
    169, // reboot
    170, // sethostname
    171, // setdomainname
    172, // iopl
    173, // ioperm
    175, // init_module
    176, // delete_module
    179, // quotactl
    227, // clock_settime
    246, // kexec_load
    248, // add_key
    249, // request_key
    250, // keyctl
    272, // unshare
    298, // perf_event_open
    303, // name_to_handle_at
    304, // open_by_handle_at
    305, // clock_adjtime
    308, // setns
    310, // process_vm_readv
    311, // process_vm_writev
    313, // finit_module
    320, // kexec_file_load
    321, // bpf
    323, // userfaultfd
];

/// Number of `sock_filter` instructions the program occupies.
pub const PROGRAM_LEN: usize = 4 + DENIED_SYSCALLS.len() * 2 + 1;

fn stmt(code: u16, k: u32) -> libc::sock_filter {
    libc::sock_filter {
        code,
        jt: 0,
        jf: 0,
        k,
    }
}

fn jump(code: u16, k: u32, jt: u8, jf: u8) -> libc::sock_filter {
    libc::sock_filter { code, jt, jf, k }
}

/// Assemble the cBPF program. Layout:
///
/// ```text
///   LD arch          ; A = seccomp_data.arch
///   JEQ x86_64,1,0   ; match → skip KILL; mismatch → KILL
///   RET KILL_PROCESS ; never reached on x86_64
///   LD nr            ; A = seccomp_data.nr
///   [JEQ denied,0,1  ; match → fall into ERRNO; else skip it
///    RET ERRNO|EPERM] per denied syscall
///   RET ALLOW        ; everything else passes
/// ```
pub fn build_seccomp_program() -> Vec<libc::sock_filter> {
    let mut program = Vec::with_capacity(PROGRAM_LEN);
    program.push(stmt(BPF_LD_W_ABS, SECCOMP_DATA_ARCH_OFFSET));
    program.push(jump(BPF_JMP_JEQ_K, AUDIT_ARCH_X86_64, 1, 0));
    program.push(stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS));
    program.push(stmt(BPF_LD_W_ABS, SECCOMP_DATA_NR_OFFSET));
    for &syscall in DENIED_SYSCALLS {
        program.push(jump(BPF_JMP_JEQ_K, syscall, 0, 1));
        program.push(stmt(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM));
    }
    program.push(stmt(BPF_RET_K, SECCOMP_RET_ALLOW));
    program
}

/// Serialize a program to the exact byte layout the kernel expects: each
/// `sock_filter` is 8 bytes, little-endian (the target is x86_64).
pub fn program_bytes(program: &[libc::sock_filter]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(program.len() * 8);
    for instruction in program {
        bytes.extend_from_slice(&instruction.code.to_le_bytes());
        bytes.push(instruction.jt);
        bytes.push(instruction.jf);
        bytes.extend_from_slice(&instruction.k.to_le_bytes());
    }
    bytes
}

/// Build the denylist program into an anonymous `memfd`, rewound to offset 0,
/// dup'ed clear of stdio (fd ≥ 3) and returned with CLOEXEC still set. The
/// caller hands the raw fd number to `bwrap --seccomp <fd>`; `process_run`
/// clears CLOEXEC in the child so the fd survives the single exec into bwrap.
#[cfg(target_os = "linux")]
pub fn open_seccomp_bpf_fd() -> CoreToolResult<OwnedFd> {
    let program = build_seccomp_program();
    let bytes = program_bytes(&program);
    // SAFETY: `name` is NUL-terminated and `memfd_create` has no preconditions.
    let name = b"mindcode-seccomp\0";
    let mut fd = unsafe { libc::memfd_create(name.as_ptr().cast(), libc::MFD_CLOEXEC) };
    if fd < 0 {
        return Err(CoreToolError::new(
            CoreToolErrorCode::ProcessSpawn,
            "memfd_create failed while preparing the seccomp program",
        ));
    }
    // Keep the fd out of stdio (0/1/2) so it can never collide with stdin,
    // stdout, or stderr in the child.
    if fd < 3 {
        // SAFETY: `fd` is a valid open descriptor.
        let dup = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
        // SAFETY: `fd` is valid; it is closed on the error path and replaced
        // by `dup` on the success path.
        unsafe { libc::close(fd) };
        if dup < 0 {
            return Err(CoreToolError::new(
                CoreToolErrorCode::ProcessSpawn,
                "fcntl(F_DUPFD_CLOEXEC) failed while preparing the seccomp program",
            ));
        }
        fd = dup;
    }
    // SAFETY: `fd` is a valid owned descriptor; `File` takes ownership exactly
    // once and is converted back into an `OwnedFd` so it stays open.
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    file.write_all(&bytes).map_err(|_| {
        CoreToolError::new(
            CoreToolErrorCode::ProcessSpawn,
            "failed to write the seccomp program",
        )
    })?;
    // bwrap reads the fd from the current offset; rewind so it sees the whole
    // program from the first instruction.
    file.seek(SeekFrom::Start(0)).map_err(|_| {
        CoreToolError::new(
            CoreToolErrorCode::ProcessSpawn,
            "failed to rewind the seccomp program",
        )
    })?;
    Ok(file.into())
}

#[cfg(not(target_os = "linux"))]
pub fn open_seccomp_bpf_fd() -> CoreToolResult<OwnedFd> {
    Err(CoreToolError::new(
        CoreToolErrorCode::ProcessSpawn,
        "seccomp sandboxing is only supported on Linux",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn program_starts_with_arch_gate_and_ends_with_allow() {
        let program = build_seccomp_program();
        assert_eq!(program.len(), PROGRAM_LEN);
        // Arch gate: LD arch, JEQ x86_64 (jt=1 skips KILL), RET KILL.
        assert_eq!(program[0].code, BPF_LD_W_ABS);
        assert_eq!(program[0].k, SECCOMP_DATA_ARCH_OFFSET);
        assert_eq!(program[1].code, BPF_JMP_JEQ_K);
        assert_eq!(program[1].k, AUDIT_ARCH_X86_64);
        assert_eq!(program[1].jt, 1);
        assert_eq!(program[1].jf, 0);
        assert_eq!(program[2].code, BPF_RET_K);
        assert_eq!(program[2].k, SECCOMP_RET_KILL_PROCESS);
        // Syscall load.
        assert_eq!(program[3].code, BPF_LD_W_ABS);
        assert_eq!(program[3].k, SECCOMP_DATA_NR_OFFSET);
        // Final instruction allows everything not explicitly denied.
        let last = program.last().expect("program is non-empty");
        assert_eq!(last.code, BPF_RET_K);
        assert_eq!(last.k, SECCOMP_RET_ALLOW);
    }

    #[test]
    fn every_denied_syscall_is_followed_by_errno_return() {
        let program = build_seccomp_program();
        // Skip the 4-instruction prologue (arch gate + nr load).
        let mut index = 4;
        for &syscall in DENIED_SYSCALLS {
            let check = &program[index];
            assert_eq!(check.code, BPF_JMP_JEQ_K);
            assert_eq!(check.k, syscall);
            assert_eq!(check.jt, 0, "match must fall into the ERRNO return");
            assert_eq!(check.jf, 1, "miss must skip the ERRNO return");
            let reject = &program[index + 1];
            assert_eq!(reject.code, BPF_RET_K);
            assert_eq!(reject.k, SECCOMP_RET_ERRNO | EPERM);
            index += 2;
        }
    }

    #[test]
    fn bytes_are_little_endian_and_eight_per_instruction() {
        let program = build_seccomp_program();
        let bytes = program_bytes(&program);
        assert_eq!(bytes.len(), program.len() * 8);
        // First instruction (LD arch): code 0x0020 LE, jt/jf 0, k 0x00000004 LE.
        assert_eq!(
            &bytes[0..8],
            &[0x20, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn memfd_round_trips_the_program_at_offset_zero() {
        let fd = open_seccomp_bpf_fd().expect("memfd must open");
        let mut file = std::fs::File::from(fd);
        file.seek(SeekFrom::Start(0)).unwrap();
        let mut contents = Vec::new();
        std::io::Read::read_to_end(&mut file, &mut contents).unwrap();
        assert_eq!(contents, program_bytes(&build_seccomp_program()));
    }
}
