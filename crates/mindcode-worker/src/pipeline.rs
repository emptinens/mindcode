//! Deterministic worker pipeline skeleton (§5.1.6, foundation for 0.1.5).
//!
//! The free-form [`WorkerAgent`] loop remains unchanged.  This module adds an
//! opt-in coordinator that makes the phase order explicit and refuses to close
//! a pipeline without executable verification evidence.  It is deliberately
//! provider-agnostic: tests use a local scripted executor, while the optional
//! `WorkerAgent` adapter is invoked only by a caller that explicitly selects
//! pipeline mode.

use crate::{WorkerAgent, WorkerReport, WorkerStatus};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

/// The fixed pipeline order.  A phase cannot be skipped or repeated.
pub const PIPELINE_PHASES: [PipelinePhase; 5] = [
    PipelinePhase::Scout,
    PipelinePhase::Plan,
    PipelinePhase::Patch,
    PipelinePhase::Verify,
    PipelinePhase::Report,
];

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum PipelinePhase {
    Scout,
    Plan,
    Patch,
    Verify,
    Report,
}

impl PipelinePhase {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Scout => "SCOUT",
            Self::Plan => "PLAN",
            Self::Patch => "PATCH",
            Self::Verify => "VERIFY",
            Self::Report => "REPORT",
        }
    }

    pub const fn index(self) -> usize {
        match self {
            Self::Scout => 0,
            Self::Plan => 1,
            Self::Patch => 2,
            Self::Verify => 3,
            Self::Report => 4,
        }
    }
}

/// Compact, structured evidence returned by one phase.  It is intentionally
/// smaller than a full worker transcript and safe to hand to the next phase.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct PhaseEvidence {
    pub summary: String,
    pub files_changed: Vec<String>,
    pub commands_run: Vec<String>,
    pub findings: Vec<String>,
    /// Set only by VERIFY.  `Some(true)` means at least one test run executed,
    /// all recorded test runs passed, and no test reported failures.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verify_passed: Option<bool>,
}

/// Read-only context made available to a later phase.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct PipelineContext {
    pub completed: Vec<(PipelinePhase, PhaseEvidence)>,
}

impl PipelineContext {
    pub fn last(&self) -> Option<&(PipelinePhase, PhaseEvidence)> {
        self.completed.last()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PipelineReport {
    pub task: String,
    pub completed: bool,
    pub phases: Vec<(PipelinePhase, PhaseEvidence)>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PipelineError {
    EmptyTask,
    OutOfOrder {
        expected: PipelinePhase,
        received: PipelinePhase,
    },
    EmptyEvidence {
        phase: PipelinePhase,
    },
    VerificationRequired,
    PhaseFailed {
        phase: PipelinePhase,
        summary: String,
    },
}

impl fmt::Display for PipelineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyTask => formatter.write_str("pipeline task must not be empty"),
            Self::OutOfOrder { expected, received } => write!(
                formatter,
                "pipeline phase out of order: expected {}, received {}",
                expected.label(),
                received.label()
            ),
            Self::EmptyEvidence { phase } => {
                write!(
                    formatter,
                    "{} phase returned no summary evidence",
                    phase.label()
                )
            }
            Self::VerificationRequired => formatter.write_str(
                "VERIFY must execute at least one passing test run before REPORT can close",
            ),
            Self::PhaseFailed { phase, summary } => {
                write!(formatter, "{} phase failed: {summary}", phase.label())
            }
        }
    }
}

impl std::error::Error for PipelineError {}

/// Mutable state machine used by both the local executor tests and the live
/// WorkerAgent adapter.
#[derive(Clone, Debug)]
pub struct PipelineState {
    task: String,
    next_phase: usize,
    context: PipelineContext,
}

impl PipelineState {
    pub fn new(task: impl Into<String>) -> Result<Self, PipelineError> {
        let task = task.into();
        if task.trim().is_empty() {
            return Err(PipelineError::EmptyTask);
        }
        Ok(Self {
            task,
            next_phase: 0,
            context: PipelineContext::default(),
        })
    }

    pub fn task(&self) -> &str {
        &self.task
    }

    pub fn next_phase(&self) -> Option<PipelinePhase> {
        PIPELINE_PHASES.get(self.next_phase).copied()
    }

    pub fn context(&self) -> PipelineContext {
        self.context.clone()
    }

    pub fn advance(
        &mut self,
        phase: PipelinePhase,
        evidence: PhaseEvidence,
    ) -> Result<(), PipelineError> {
        let Some(expected) = self.next_phase() else {
            return Err(PipelineError::OutOfOrder {
                expected: PipelinePhase::Report,
                received: phase,
            });
        };
        if phase != expected {
            return Err(PipelineError::OutOfOrder {
                expected,
                received: phase,
            });
        }
        if evidence.summary.trim().is_empty() {
            return Err(PipelineError::EmptyEvidence { phase });
        }
        if phase == PipelinePhase::Verify && evidence.verify_passed != Some(true) {
            return Err(PipelineError::VerificationRequired);
        }
        self.context.completed.push((phase, evidence));
        self.next_phase += 1;
        Ok(())
    }

    pub fn finish(self) -> PipelineReport {
        PipelineReport {
            task: self.task,
            completed: self.next_phase == PIPELINE_PHASES.len(),
            phases: self.context.completed,
        }
    }
}

/// Boxed future used to keep this crate free of an async-trait dependency.
pub type PhaseFuture<'a> =
    Pin<Box<dyn Future<Output = Result<PhaseEvidence, PipelineError>> + Send + 'a>>;

/// The phase executor boundary.  It is intentionally small so a daemon,
/// scripted test, or another local coordinator can provide the implementation
/// without coupling the state machine to a provider SDK.
pub trait PipelineExecutor {
    fn execute<'a>(
        &'a mut self,
        phase: PipelinePhase,
        task: &'a str,
        context: &'a PipelineContext,
    ) -> PhaseFuture<'a>;
}

/// Run all five phases in order.  The executor is called exactly once per
/// phase; any missing or failed verification stops the pipeline before REPORT.
pub async fn run_pipeline<E: PipelineExecutor>(
    task: impl Into<String>,
    executor: &mut E,
) -> Result<PipelineReport, PipelineError> {
    let mut state = PipelineState::new(task)?;
    for phase in PIPELINE_PHASES {
        let context = state.context();
        let evidence = executor.execute(phase, state.task(), &context).await?;
        state.advance(phase, evidence)?;
    }
    Ok(state.finish())
}

/// Prompt contract used by the live adapter.  The phase marker is explicit so
/// a model cannot mistake a free-form report for a different stage.
pub fn phase_prompt(phase: PipelinePhase, task: &str, context: &PipelineContext) -> String {
    let previous = context
        .completed
        .iter()
        .map(|(phase, evidence)| format!("{}: {}", phase.label(), evidence.summary))
        .collect::<Vec<_>>();
    let handoff = if previous.is_empty() {
        "none".to_owned()
    } else {
        previous.join("\n")
    };
    let instruction = match phase {
        PipelinePhase::Scout => {
            "localize the task with agentgrep/rg; do not edit files in this phase"
        }
        PipelinePhase::Plan => {
            "turn the findings into a todo plan with assessment and requirement references"
        }
        PipelinePhase::Patch => "implement the approved plan inside the worker scope",
        PipelinePhase::Verify => {
            "run the project test tool and report executable pass/fail evidence; do not claim success without it"
        }
        PipelinePhase::Report => "summarize the completed work, verification, and remaining risks",
    };
    format!(
        "[PIPELINE {}]\nTask: {task}\nInstruction: {instruction}\nPrevious phase evidence:\n{handoff}",
        phase.label()
    )
}

/// Adapt the existing worker loop to the strict phase coordinator. This is
/// opt-in and performs no provider call until the caller invokes this function.
pub async fn run_pipeline_with_agent(
    agent: &WorkerAgent,
    task: impl Into<String>,
    cancel: CancellationToken,
) -> Result<PipelineReport, PipelineError> {
    let task = task.into();
    let mut executor = AgentPipelineExecutor { agent, cancel };
    run_pipeline(task, &mut executor).await
}

struct AgentPipelineExecutor<'a> {
    agent: &'a WorkerAgent,
    cancel: CancellationToken,
}

impl PipelineExecutor for AgentPipelineExecutor<'_> {
    fn execute<'a>(
        &'a mut self,
        phase: PipelinePhase,
        task: &'a str,
        context: &'a PipelineContext,
    ) -> PhaseFuture<'a> {
        let prompt = phase_prompt(phase, task, context);
        let cancel = self.cancel.clone();
        Box::pin(async move {
            let report = self.agent.run(&prompt, cancel).await;
            phase_evidence_from_report(phase, report)
        })
    }
}

fn phase_evidence_from_report(
    phase: PipelinePhase,
    report: WorkerReport,
) -> Result<PhaseEvidence, PipelineError> {
    if report.status != WorkerStatus::Success {
        return Err(PipelineError::PhaseFailed {
            phase,
            summary: if report.summary.is_empty() {
                format!("worker status: {:?}", report.status)
            } else {
                report.summary
            },
        });
    }
    let verify_passed = if phase == PipelinePhase::Verify {
        Some(
            !report.test_runs.is_empty()
                && report
                    .test_runs
                    .iter()
                    .all(|test| test.exit_code == Some(0) && test.failed == 0),
        )
    } else {
        None
    };
    Ok(PhaseEvidence {
        summary: if report.summary.is_empty() {
            format!("{} phase completed", phase.label())
        } else {
            report.summary
        },
        files_changed: report.files_changed,
        commands_run: report
            .commands_run
            .into_iter()
            .map(|command| command.command)
            .collect(),
        findings: report.findings,
        verify_passed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct ScriptedExecutor {
        calls: Arc<Mutex<Vec<PipelinePhase>>>,
        verify_passes: bool,
    }

    impl PipelineExecutor for ScriptedExecutor {
        fn execute<'a>(
            &'a mut self,
            phase: PipelinePhase,
            _task: &'a str,
            _context: &'a PipelineContext,
        ) -> PhaseFuture<'a> {
            self.calls.lock().unwrap().push(phase);
            let verify_passes = self.verify_passes;
            Box::pin(async move {
                Ok(PhaseEvidence {
                    summary: format!("{} evidence", phase.label()),
                    verify_passed: (phase == PipelinePhase::Verify).then_some(verify_passes),
                    ..Default::default()
                })
            })
        }
    }

    #[tokio::test]
    async fn pipeline_runs_exactly_five_phases_in_order() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut executor = ScriptedExecutor {
            calls: Arc::clone(&calls),
            verify_passes: true,
        };
        let report = run_pipeline("ship the patch", &mut executor).await.unwrap();
        assert!(report.completed);
        assert_eq!(report.phases.len(), PIPELINE_PHASES.len());
        assert_eq!(*calls.lock().unwrap(), PIPELINE_PHASES);
    }

    #[tokio::test]
    async fn pipeline_stops_before_report_when_verify_has_no_pass_evidence() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let mut executor = ScriptedExecutor {
            calls: Arc::clone(&calls),
            verify_passes: false,
        };
        let error = run_pipeline("ship the patch", &mut executor)
            .await
            .unwrap_err();
        assert_eq!(error, PipelineError::VerificationRequired);
        assert_eq!(
            *calls.lock().unwrap(),
            vec![
                PipelinePhase::Scout,
                PipelinePhase::Plan,
                PipelinePhase::Patch,
                PipelinePhase::Verify,
            ]
        );
    }

    #[test]
    fn state_machine_rejects_skipped_phases_and_empty_evidence() {
        let mut state = PipelineState::new("task").unwrap();
        assert!(matches!(
            state.advance(
                PipelinePhase::Patch,
                PhaseEvidence {
                    summary: "wrong phase".into(),
                    ..Default::default()
                }
            ),
            Err(PipelineError::OutOfOrder {
                expected: PipelinePhase::Scout,
                received: PipelinePhase::Patch
            })
        ));
        assert!(matches!(
            state.advance(PipelinePhase::Scout, PhaseEvidence::default()),
            Err(PipelineError::EmptyEvidence {
                phase: PipelinePhase::Scout
            })
        ));
    }

    #[test]
    fn phase_prompt_carries_explicit_stage_and_handoffs() {
        let mut context = PipelineContext::default();
        context.completed.push((
            PipelinePhase::Scout,
            PhaseEvidence {
                summary: "found src/lib.rs".into(),
                ..Default::default()
            },
        ));
        let prompt = phase_prompt(PipelinePhase::Plan, "fix tests", &context);
        assert!(prompt.contains("[PIPELINE PLAN]"));
        assert!(prompt.contains("SCOUT: found src/lib.rs"));
        assert!(prompt.contains("assessment"));
    }
}
