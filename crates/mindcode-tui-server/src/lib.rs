//! In-process control server for the native MindCode TUI.
//!
//! The UI protocol v2 wire types live in `mindcode-protocol::ui`; this crate
//! owns the server side of that protocol — the Unix-socket listener, the
//! handshake and capability negotiation, the backpressure-bounded outbound
//! queue, input routing, and the state-to-snapshot projection.  Everything is
//! hermetic: no network I/O beyond the local control socket and no live
//! provider is ever contacted.

#![forbid(unsafe_code)]

pub mod projection;
pub mod server;

pub use projection::{
    ActivityInput, AgentInput, ChangeInput, ConnectionInput, PermissionInput, ProjectionError,
    ProjectionInput, ProjectionStore, ProviderInput, RevisionClock, SessionInput, StatusInput,
    TaskInput, TaskMetadataInput, TelemetryInput, TranscriptInput, TranscriptWindowInput,
    WorkspaceInput, WriterInput,
};
pub use server::{ControlServer, ControlServerConfig, ControlServerError, InputHandler};
