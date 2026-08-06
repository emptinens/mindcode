use std::env;

use mindcode_tui::{parse_args, run};

fn main() {
    let config = match parse_args(env::args_os().skip(1)) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("mindcode-tui: {error}");
            std::process::exit(2);
        }
    };

    #[cfg(windows)]
    {
        eprintln!("mindcode-tui: unsupported platform: Windows");
        let _ = config;
        return;
    }

    #[cfg(not(windows))]
    if let Err(error) = run(config) {
        eprintln!("mindcode-tui: {error}");
        std::process::exit(1);
    }
}
