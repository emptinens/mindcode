//! The bounded worker executor: at most `max_concurrent` worker tasks run at
//! once (hard cap 20), with per-task cancellation and a wall-clock timeout.

use crate::error::{WorkerError, WorkerResult};
use crate::report::WorkerReport;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;

pub const DEFAULT_MAX_CONCURRENT: usize = 4;
pub const MAX_CONCURRENT_CAP: usize = 20;
pub const DEFAULT_WORKER_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// The result of one pool run.
#[derive(Clone, Debug)]
pub struct PoolOutcome {
    /// The worker's report, absent when the task was cancelled or timed out
    /// before it could produce one.
    pub report: Option<WorkerReport>,
    pub timed_out: bool,
    pub cancelled: bool,
}

#[derive(Clone)]
pub struct WorkerPool {
    semaphore: Arc<Semaphore>,
    max_concurrent: usize,
    timeout: Duration,
}

impl WorkerPool {
    pub fn new(max_concurrent: usize, timeout: Duration) -> WorkerResult<Self> {
        if !(1..=MAX_CONCURRENT_CAP).contains(&max_concurrent) {
            return Err(WorkerError::InvalidRequest(format!(
                "max_concurrent must be between 1 and {MAX_CONCURRENT_CAP}"
            )));
        }
        if timeout.is_zero() {
            return Err(WorkerError::InvalidRequest(
                "worker timeout must be non-zero".to_owned(),
            ));
        }
        Ok(Self {
            semaphore: Arc::new(Semaphore::new(max_concurrent)),
            max_concurrent,
            timeout,
        })
    }

    pub fn with_defaults(max_concurrent: usize) -> WorkerResult<Self> {
        Self::new(max_concurrent, DEFAULT_WORKER_TIMEOUT)
    }

    pub fn max_concurrent(&self) -> usize {
        self.max_concurrent
    }

    /// Run one worker task under the concurrency bound. The task runs while a
    /// permit is held; it is cancelled by `cancel` and dropped at `timeout`.
    /// Tasks that spawn processes should forward `cancel` to them so a cancel
    /// or timeout tears down descendants too.
    pub async fn run<F, Fut>(&self, cancel: CancellationToken, task: F) -> PoolOutcome
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: std::future::Future<Output = WorkerReport> + Send,
    {
        let permit = match self.semaphore.clone().acquire_owned().await {
            Ok(permit) => permit,
            Err(_) => {
                return PoolOutcome {
                    report: None,
                    timed_out: false,
                    cancelled: true,
                };
            }
        };
        let result = tokio::select! {
            _ = cancel.cancelled() => None,
            report = tokio::time::timeout(self.timeout, task()) => report.ok(),
        };
        drop(permit);
        if result.is_none() {
            return PoolOutcome {
                report: None,
                timed_out: !cancel.is_cancelled(),
                cancelled: cancel.is_cancelled(),
            };
        }
        PoolOutcome {
            report: result,
            timed_out: false,
            cancelled: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::{WorkerReport, WorkerStatus};
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn ok_report() -> WorkerReport {
        WorkerReport {
            id: "w".into(),
            status: WorkerStatus::Success,
            ..Default::default()
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn bounds_concurrency_to_the_configured_limit() {
        let pool = WorkerPool::new(2, Duration::from_secs(5)).unwrap();
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..6 {
            let pool = pool.clone();
            let active = Arc::clone(&active);
            let peak = Arc::clone(&peak);
            handles.push(tokio::spawn(async move {
                pool.run(CancellationToken::new(), move || {
                    let active = Arc::clone(&active);
                    let peak = Arc::clone(&peak);
                    async move {
                        let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(40)).await;
                        active.fetch_sub(1, Ordering::SeqCst);
                        ok_report()
                    }
                })
                .await
            }));
        }
        for handle in handles {
            handle.await.unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn cancellation_returns_without_a_report() {
        let pool = WorkerPool::with_defaults(1).unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let outcome = pool
            .run(cancel, || async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                ok_report()
            })
            .await;
        assert!(outcome.cancelled);
        assert!(!outcome.timed_out);
        assert!(outcome.report.is_none());
    }

    #[tokio::test]
    async fn timeout_drops_a_slow_task() {
        let pool = WorkerPool::new(1, Duration::from_millis(20)).unwrap();
        let outcome = pool
            .run(CancellationToken::new(), || async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                ok_report()
            })
            .await;
        assert!(outcome.timed_out);
        assert!(!outcome.cancelled);
        assert!(outcome.report.is_none());
    }

    #[test]
    fn rejects_invalid_concurrency_and_timeout() {
        assert!(WorkerPool::with_defaults(0).is_err());
        assert!(WorkerPool::with_defaults(21).is_err());
        assert!(WorkerPool::new(2, Duration::ZERO).is_err());
    }
}
