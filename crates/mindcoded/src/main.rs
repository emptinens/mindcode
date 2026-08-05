use clap::Parser;
use mindcoded::{Daemon, DaemonConfig};
use std::{path::PathBuf, time::Duration};

#[derive(Debug, Parser)]
#[command(name = "mindcoded", version, about = "MindCode local daemon")]
struct Args {
    #[arg(long, value_name = "PATH", default_value_os_t = DaemonConfig::default_socket())]
    socket: PathBuf,
    #[arg(long, value_name = "SECONDS", default_value_t = 1800)]
    idle_seconds: u64,
    #[arg(long, value_name = "HANDSHAKE_SECONDS", default_value_t = 5)]
    handshake_timeout_seconds: u64,
    #[arg(long, value_name = "BUILD", default_value = "dev")]
    build_id: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    Daemon::new(DaemonConfig {
        socket: args.socket,
        idle_seconds: Some(args.idle_seconds),
        handshake_timeout: Duration::from_secs(args.handshake_timeout_seconds),
        build_id: args.build_id,
    })
    .run()
    .await
}
