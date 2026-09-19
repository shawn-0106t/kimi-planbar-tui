// Entry point. Self-check args (--test-fetch / --test-update) run first,
// print, and exit (SPEC 19). Unlike the tray editions there is no
// single-instance mutex — multiple TUI instances are allowed (SPEC 20).

mod app;
mod credentials;
mod format;
mod polling;
mod quota;
mod settings;
mod skills;
mod state;
mod theme;
mod ui;
mod update;

fn dotnet_bool(b: bool) -> &'static str {
    // C# string interpolation prints True/False; kept so --test-update output
    // can be diffed field by field against the tray editions
    if b {
        "True"
    } else {
        "False"
    }
}

fn block_on<F: std::future::Future>(fut: F) -> F::Output {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime");
    rt.block_on(fut)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // Headless quota self-check: fetch once, print indented JSON, exit
    if args.iter().any(|a| a == "--test-fetch") {
        let r = block_on(quota::fetch());
        match serde_json::to_string_pretty(&r) {
            Ok(j) => println!("{j}"),
            Err(e) => println!("serialize error: {e}"),
        }
        return;
    }

    // Headless update-check self-check: single-line summary, exit
    if args.iter().any(|a| a == "--test-update") {
        let st = block_on(update::check());
        println!(
            "local={} latest={} updateAvailable={} checkFailed={}",
            st.local_version.as_deref().unwrap_or(""),
            st.latest_version.as_deref().unwrap_or(""),
            dotnet_bool(st.update_available),
            dotnet_bool(st.check_failed),
        );
        return;
    }

    if let Err(e) = block_on(app::run()) {
        eprintln!("fatal: {e}");
        std::process::exit(1);
    }
}
