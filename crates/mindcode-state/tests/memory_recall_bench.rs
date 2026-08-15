//! Offline memory-v2 retrieval evaluation.
//!
//! This is intentionally ignored: running a memory-recall evaluation is a
//! benchmark operation and requires explicit owner consent. It uses only a
//! deterministic local corpus and never contacts a provider.

use mindcode_state::{MemoryRecord, MemoryScope, MemoryStore, MemoryType};
use std::env;

struct RetrievalCase {
    query: &'static str,
    relevant: &'static [&'static str],
}

fn corpus() -> MemoryStore {
    let rows = [
        (
            "rust-target",
            "cargo build fails when the rust target is not installed",
        ),
        (
            "cargo-tests",
            "run cargo test with focused package filters before the full workspace",
        ),
        (
            "provider-effort",
            "reasoning effort is sent on both the OpenAI and Anthropic provider wires",
        ),
        (
            "provider-secret",
            "provider credentials resolve from environment before the local secret store",
        ),
        (
            "daemon-reload",
            "daemon reload preserves the Unix socket and reconnects TUI leases",
        ),
        (
            "daemon-session",
            "session manager uses reconnect leases and rejects project conflicts",
        ),
        (
            "worker-scope",
            "workers must receive disjoint read and write scopes for parallel tasks",
        ),
        (
            "worker-report",
            "worker reports are untrusted evidence and never become system instructions",
        ),
        (
            "memory-project",
            "project memory is partitioned by a stable checkout key",
        ),
        (
            "memory-decay",
            "memory confidence decays by type half life and reinforcement refreshes it",
        ),
        (
            "sandbox-network",
            "bwrap worker shells disable network access unless an explicit flag enables it",
        ),
        (
            "sandbox-hooks",
            "worker hooks fail closed when a configured hook cannot be executed",
        ),
        (
            "tui-colors",
            "the TUI colors command writes secret free palette overrides and hot reloads them",
        ),
        (
            "tui-markdown",
            "markdown headings lists and Mermaid fences render as bounded terminal text",
        ),
        (
            "cost-ledger",
            "the append only cost ledger keeps unknown provider usage as null rather than zero",
        ),
        (
            "soft-interrupt",
            "soft interrupt input waits for a streaming safe point and preserves message order",
        ),
        (
            "task-verify",
            "deep task graph nodes require a passing verify artifact before completion",
        ),
        (
            "task-light",
            "light task graph scheduling uses bounded flat fan out without worker recursion",
        ),
        (
            "read-redaction",
            "read file output is redacted before source content reaches the model",
        ),
        (
            "injection-boundary",
            "tool output is delimited and labeled as untrusted evidence",
        ),
    ];
    let mut store = MemoryStore::default();
    for (id, text) in rows {
        store
            .insert(MemoryRecord {
                id: id.to_owned(),
                memory_type: MemoryType::Fact,
                scope: MemoryScope::Project,
                text: text.to_owned(),
                provenance: "offline-memory-v2-bench".to_owned(),
                created_at_ms: 0,
                reinforced_at_ms: 0,
                reinforcement: 0,
                confidence: 0.9,
                private: false,
            })
            .unwrap();
    }
    store
}

fn cases() -> [RetrievalCase; 10] {
    [
        RetrievalCase {
            query: "rust target cargo build",
            relevant: &["rust-target", "cargo-tests"],
        },
        RetrievalCase {
            query: "provider reasoning effort wire",
            relevant: &["provider-effort", "provider-secret"],
        },
        RetrievalCase {
            query: "daemon session reconnect reload",
            relevant: &["daemon-reload", "daemon-session"],
        },
        RetrievalCase {
            query: "parallel worker scopes",
            relevant: &["worker-scope", "task-light"],
        },
        RetrievalCase {
            query: "memory confidence decay",
            relevant: &["memory-decay", "memory-project"],
        },
        RetrievalCase {
            query: "sandbox bwrap network hooks",
            relevant: &["sandbox-network", "sandbox-hooks"],
        },
        RetrievalCase {
            query: "TUI colors markdown Mermaid",
            relevant: &["tui-colors", "tui-markdown"],
        },
        RetrievalCase {
            query: "unknown cost ledger null usage",
            relevant: &["cost-ledger", "provider-secret"],
        },
        RetrievalCase {
            query: "streaming soft interrupt safe point",
            relevant: &["soft-interrupt", "worker-report"],
        },
        RetrievalCase {
            query: "verify task graph completion",
            relevant: &["task-verify", "task-light"],
        },
    ]
}

fn dcg(ranks: &[usize]) -> f64 {
    ranks
        .iter()
        .map(|rank| 1.0 / ((*rank as f64) + 2.0).log2())
        .sum()
}

#[test]
#[ignore = "owner consent required for memory-recall benchmark"]
fn memory_v2_recall_reports_recall_mrr_and_ndcg() {
    let store = corpus();
    let mut recall_at_5 = 0.0;
    let mut recall_at_10 = 0.0;
    let mut mrr = 0.0;
    let mut ndcg = 0.0;

    for case in cases() {
        let results = store.hybrid_search_at(case.query, 10, 0.0, 0);
        let relevant = case
            .relevant
            .iter()
            .copied()
            .collect::<std::collections::HashSet<_>>();
        let ranks = results
            .iter()
            .enumerate()
            .filter_map(|(index, result)| {
                relevant
                    .contains(result.record.id.as_str())
                    .then_some(index)
            })
            .collect::<Vec<_>>();
        recall_at_5 +=
            ranks.iter().filter(|rank| **rank < 5).count() as f64 / case.relevant.len() as f64;
        recall_at_10 += ranks.len() as f64 / case.relevant.len() as f64;
        if let Some(rank) = ranks.first() {
            mrr += 1.0 / (*rank as f64 + 1.0);
        }
        let ideal = (0..case.relevant.len()).collect::<Vec<_>>();
        ndcg += dcg(&ranks) / dcg(&ideal).max(f64::EPSILON);
    }

    let count = cases().len() as f64;
    recall_at_5 /= count;
    recall_at_10 /= count;
    mrr /= count;
    ndcg /= count;
    println!(
        "memory-v2 recall@5={recall_at_5:.4} recall@10={recall_at_10:.4} mrr={mrr:.4} ndcg@10={ndcg:.4}"
    );

    if env::var_os("MINDCODE_MEMORY_RECALL_GATE").is_some() {
        assert!(
            recall_at_10 >= 0.70,
            "memory-v2 recall@10 {recall_at_10:.4} is below the 0.70 acceptance gate"
        );
    }
}
