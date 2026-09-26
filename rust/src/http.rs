// Shared HTTP client (REVIEW-RUST Suggestion 8): one lazily-initialized
// reqwest client — and therefore one connection pool — for both consumers,
// the quota fetch (quota.rs) and the update check (update.rs). 10s timeout,
// construction failure degrades to None and the caller reports its failure
// kind (HttpRequestException / check_failed), per the silent-swallow baseline.

use reqwest::Client;
use std::sync::OnceLock;
use std::time::Duration;

pub(crate) fn shared_client() -> Option<&'static Client> {
    static CLIENT: OnceLock<Option<Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| Client::builder().timeout(Duration::from_secs(10)).build().ok())
        .as_ref()
}
