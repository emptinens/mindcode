use mindcode_state::{
    ClaimOptions, ClaimResult, TaskGraph, TaskGraphConfig, TaskInput, TaskStatus,
};
use std::env;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use tempfile::tempdir;

const HELPER_ENV: &str = "MINDCODE_STATE_MP_HELPER";
const STATE_DIR_ENV: &str = "MINDCODE_STATE_MP_STATE_DIR";
const ENDPOINT_ENV: &str = "MINDCODE_STATE_MP_ENDPOINT";
const CLAIM_HELPER: &str = "multiprocess_claim_helper";
const ABRUPT_HELPER: &str = "multiprocess_abrupt_claim_helper";
const CLAIM_NOW: &str = "2026-08-06T00:00:00Z";
const RECOVERY_NOW: &str = "2026-08-06T00:00:00.010Z";
const READY: u8 = b'R';
const START: u8 = b'G';
const CLAIMED: u8 = b'C';
const SUCCESS: u8 = b'S';
const FAILURE: u8 = b'F';
const ABRUPT_EXIT_CODE: i32 = 86;
const POLL_INTERVAL: Duration = Duration::from_millis(2);
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const IO_TIMEOUT: Duration = Duration::from_secs(2);
const BARRIER_TIMEOUT: Duration = Duration::from_secs(30);

#[test]
fn multiprocess_claim_helper() {
    if env::var(HELPER_ENV).as_deref() != Ok("claim") {
        return;
    }

    let state_dir = required_env_path(STATE_DIR_ENV);
    let mut socket = connect_to_barrier();
    wait_for_start(&mut socket);
    let graph = open_graph(&state_dir, 60_000);
    let result = graph
        .claim(
            "contention-task",
            &format!("process-{}", std::process::id()),
            ClaimOptions {
                now: Some(CLAIM_NOW.to_owned()),
                ttl_ms: Some(60_000),
                ..Default::default()
            },
        )
        .expect("claim helper could not access SQLite");
    let outcome = match result {
        ClaimResult::Success(_) => SUCCESS,
        ClaimResult::Failure(_) => FAILURE,
    };
    socket
        .write_all(&[outcome])
        .expect("claim helper could not report its result");
}

#[test]
fn multiprocess_abrupt_claim_helper() {
    if env::var(HELPER_ENV).as_deref() != Ok("abrupt") {
        return;
    }

    let state_dir = required_env_path(STATE_DIR_ENV);
    let mut socket = connect_to_barrier();
    wait_for_start(&mut socket);
    let graph = open_graph(&state_dir, 1);
    let result = graph
        .claim(
            "recovery-task",
            "abrupt-process",
            ClaimOptions {
                lease_id: Some("abrupt-process-lease".to_owned()),
                now: Some(CLAIM_NOW.to_owned()),
                ttl_ms: Some(1),
                ..Default::default()
            },
        )
        .expect("abrupt helper could not commit its claim");
    assert!(matches!(result, ClaimResult::Success(_)));
    socket
        .write_all(&[CLAIMED])
        .expect("abrupt helper could not report its committed claim");

    // Deliberately bypass Rust destructors after the claim transaction has
    // returned. The parent must recover the expired lease, not rely on Drop.
    std::process::exit(ABRUPT_EXIT_CODE);
}

#[test]
fn independent_processes_have_one_sqlite_claim_winner() {
    let directory = tempdir().unwrap();
    let graph = open_graph(directory.path(), 60_000);
    graph
        .create(TaskInput {
            id: Some("contention-task".to_owned()),
            ..Default::default()
        })
        .unwrap();

    let (listener, endpoint) = barrier_listener();
    let mut children = ChildGuard::spawn(CLAIM_HELPER, "claim", directory.path(), endpoint, 8);
    let mut sockets = accept_ready(&listener, children.len());
    release_barrier(&mut sockets);
    let outcomes = read_outcomes(&mut sockets, SUCCESS, FAILURE);
    let statuses = children.wait_all().unwrap();

    assert!(statuses.iter().all(ExitStatus::success));
    assert_eq!(
        outcomes
            .iter()
            .filter(|&&outcome| outcome == SUCCESS)
            .count(),
        1
    );
    assert_eq!(
        outcomes
            .iter()
            .filter(|&&outcome| outcome == FAILURE)
            .count(),
        7
    );
    assert_eq!(
        graph.read("contention-task").unwrap().unwrap().status,
        TaskStatus::Claimed
    );
}

#[test]
fn abrupt_process_claim_is_recovered_after_lease_expiry() {
    let directory = tempdir().unwrap();
    let graph = open_graph(directory.path(), 1);
    graph
        .create(TaskInput {
            id: Some("recovery-task".to_owned()),
            ..Default::default()
        })
        .unwrap();

    let (listener, endpoint) = barrier_listener();
    let mut children = ChildGuard::spawn(ABRUPT_HELPER, "abrupt", directory.path(), endpoint, 1);
    let mut sockets = accept_ready(&listener, children.len());
    release_barrier(&mut sockets);
    let mut claim_signal = [0; 1];
    sockets[0]
        .read_exact(&mut claim_signal)
        .expect("abrupt helper did not report its committed claim");
    assert_eq!(claim_signal[0], CLAIMED);
    let statuses = children.wait_all().unwrap();
    assert_eq!(statuses[0].code(), Some(ABRUPT_EXIT_CODE));

    let recovery = graph.recover(Some(RECOVERY_NOW)).unwrap();
    assert_eq!(recovery.expired_leases.len(), 1);
    assert_eq!(recovery.expired_leases[0].lease_id, "abrupt-process-lease");
    assert_eq!(recovery.recovered_tasks.len(), 1);
    assert_eq!(recovery.recovered_tasks[0].id, "recovery-task");
    assert_eq!(
        graph.read("recovery-task").unwrap().unwrap().status,
        TaskStatus::Pending
    );

    let reclaimed = graph
        .claim(
            "recovery-task",
            "recovery-process",
            ClaimOptions {
                lease_id: Some("recovery-process-lease".to_owned()),
                now: Some(RECOVERY_NOW.to_owned()),
                ttl_ms: Some(60_000),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(matches!(reclaimed, ClaimResult::Success(_)));
}

struct ChildGuard {
    children: Vec<Child>,
}

impl ChildGuard {
    fn spawn(
        test_name: &str,
        helper: &str,
        state_dir: &Path,
        endpoint: SocketAddr,
        count: usize,
    ) -> Self {
        let executable = env::current_exe().unwrap();
        let state_dir = state_dir
            .to_str()
            .expect("temporary state path is not UTF-8");
        let endpoint = endpoint.to_string();
        let children = (0..count)
            .map(|_| {
                Command::new(&executable)
                    .args(["--exact", test_name, "--nocapture"])
                    .env(HELPER_ENV, helper)
                    .env(STATE_DIR_ENV, state_dir)
                    .env(ENDPOINT_ENV, &endpoint)
                    .env("RUST_BACKTRACE", "1")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap()
            })
            .collect();
        Self { children }
    }

    fn len(&self) -> usize {
        self.children.len()
    }

    fn wait_all(&mut self) -> io::Result<Vec<ExitStatus>> {
        self.children.iter_mut().map(Child::wait).collect()
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        for child in &mut self.children {
            let _ = child.kill();
        }
        for child in &mut self.children {
            let _ = child.wait();
        }
    }
}

fn open_graph(state_dir: &Path, lease_ttl_ms: u64) -> TaskGraph {
    TaskGraph::open(TaskGraphConfig {
        state_dir: state_dir.to_path_buf(),
        lease_ttl_ms,
    })
    .unwrap()
}

fn barrier_listener() -> (TcpListener, SocketAddr) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = listener.local_addr().unwrap();
    (listener, endpoint)
}

fn accept_ready(listener: &TcpListener, expected: usize) -> Vec<TcpStream> {
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut sockets = Vec::with_capacity(expected);
    while sockets.len() < expected {
        match listener.accept() {
            Ok((mut socket, _)) => {
                socket.set_nonblocking(false).unwrap();
                socket.set_read_timeout(Some(BARRIER_TIMEOUT)).unwrap();
                socket.set_write_timeout(Some(IO_TIMEOUT)).unwrap();
                let mut signal = [0; 1];
                socket.read_exact(&mut signal).unwrap();
                assert_eq!(signal[0], READY);
                sockets.push(socket);
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                assert!(
                    Instant::now() < deadline,
                    "timed out waiting for child readiness"
                );
                thread::sleep(POLL_INTERVAL);
            }
            Err(error) => panic!("accepting child readiness connection failed: {error}"),
        }
    }
    sockets
}

fn release_barrier(sockets: &mut [TcpStream]) {
    for socket in sockets {
        socket.write_all(&[START]).unwrap();
    }
}

fn read_outcomes(sockets: &mut [TcpStream], success: u8, failure: u8) -> Vec<u8> {
    sockets
        .iter_mut()
        .map(|socket| {
            let mut outcome = [0; 1];
            socket.read_exact(&mut outcome).unwrap();
            assert!(outcome[0] == success || outcome[0] == failure);
            outcome[0]
        })
        .collect()
}

fn connect_to_barrier() -> TcpStream {
    let endpoint = env::var(ENDPOINT_ENV)
        .expect("child endpoint is missing")
        .parse::<SocketAddr>()
        .expect("child endpoint is invalid");
    let socket =
        TcpStream::connect_timeout(&endpoint, IO_TIMEOUT).expect("child could not connect");
    socket.set_nonblocking(false).unwrap();
    socket.set_read_timeout(Some(BARRIER_TIMEOUT)).unwrap();
    socket.set_write_timeout(Some(IO_TIMEOUT)).unwrap();
    socket
}

fn wait_for_start(socket: &mut TcpStream) {
    socket.write_all(&[READY]).unwrap();
    let mut signal = [0; 1];
    socket.read_exact(&mut signal).unwrap();
    assert_eq!(signal[0], START);
}

fn required_env_path(name: &str) -> std::path::PathBuf {
    env::var(name)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| panic!("child environment variable {name} is missing"))
}
