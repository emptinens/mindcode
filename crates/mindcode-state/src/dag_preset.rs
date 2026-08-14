//! Task-DAG presets and structural validation (§12.1).
//!
//! The task DAG is the primary object; workers are an interchangeable pool of
//! executors. This module owns the two presets and the invariants they impose:
//! `light` is a flat fan-out with verify gates off and a small cap; `deep`
//! allows coordinator decomposition, enforces mandatory verify gates before a
//! node closes, and raises the cap. In both presets workers never spawn
//! workers: only the coordinator creates nodes.

use std::collections::{HashMap, HashSet};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DagPreset {
    #[default]
    Light,
    Deep,
}

impl DagPreset {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Deep => "deep",
        }
    }

    /// Verify gates are mandatory only in `deep` (Q11=б).
    pub const fn verify_gates(self) -> bool {
        matches!(self, Self::Deep)
    }

    /// Node cap: 16 in `light`, 1000 in `deep` (Q9=б).
    pub const fn max_nodes(self) -> usize {
        match self {
            Self::Light => 16,
            Self::Deep => 1000,
        }
    }

    /// Whether the coordinator may decompose a node into subnodes.
    pub const fn allows_decomposition(self) -> bool {
        matches!(self, Self::Deep)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeKind {
    Research,
    Implement,
    Verify,
    Integrate,
}

impl NodeKind {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Research => "research",
            Self::Implement => "implement",
            Self::Verify => "verify",
            Self::Integrate => "integrate",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeStatus {
    Pending,
    Runnable,
    Running,
    Completed,
    Failed,
}

/// A typed handoff artifact carried on dependency edges (§12.1).  The honest
/// `what_i_did_not_check` field is structural: an artifact that claims to have
/// verified everything is rejected, not rewarded.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct VerifyArtifact {
    pub findings: Vec<String>,
    /// `file:line` evidence, kept as opaque strings.
    pub evidence: Vec<String>,
    pub edge_cases: Vec<String>,
    pub what_i_did_not_check: Vec<String>,
    pub open_questions: Vec<String>,
    pub confidence: f64,
    /// Every completed node this artifact covers; empty is rejected in `deep`.
    pub verified_nodes: Vec<String>,
}

impl VerifyArtifact {
    /// The structural honesty rule: a non-empty `what_i_did_not_check` plus at
    /// least one verified node.  "All good, no gaps" (empty both) is rejected.
    pub fn is_structurally_honest(&self) -> bool {
        !self.verified_nodes.is_empty() && !self.what_i_did_not_check.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DagNode {
    pub id: String,
    pub kind: NodeKind,
    /// Ids this node depends on.  In `light` this must be empty (flat fan-out).
    pub dependencies: Vec<String>,
    pub status: NodeStatus,
    /// Whether the node has closed (completed/failed).  In `deep` a node may
    /// only close once its verify gate has a structurally honest artifact.
    pub closed: bool,
    pub verification: Option<VerifyArtifact>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DagValidationError {
    DuplicateNode(String),
    SelfDependency(String),
    MissingDependency { node: String, dependency: String },
    Cycle { node: String },
    NodeCapExceeded { limit: usize },
    DecompositionInLight { node: String },
    VerifyRequired { node: String },
    VerifyNotHonest { node: String },
    VerifyIncompleteCoverage { node: String, missing: Vec<String> },
    InvalidConfidence(String),
}

impl fmt::Display for DagValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateNode(id) => write!(formatter, "duplicate node: {id}"),
            Self::SelfDependency(id) => write!(formatter, "node depends on itself: {id}"),
            Self::MissingDependency { node, dependency } => {
                write!(formatter, "node {node} references missing dependency {dependency}")
            }
            Self::Cycle { node } => write!(formatter, "dependency cycle through {node}"),
            Self::NodeCapExceeded { limit } => {
                write!(formatter, "task DAG exceeds the node cap of {limit}")
            }
            Self::DecompositionInLight { node } => {
                write!(formatter, "light preset forbids node dependencies: {node}")
            }
            Self::VerifyRequired { node } => {
                write!(formatter, "deep preset requires a verify gate before {node} closes")
            }
            Self::VerifyNotHonest { node } => {
                write!(formatter, "verify artifact for {node} is not structurally honest")
            }
            Self::VerifyIncompleteCoverage { node, missing } => {
                write!(
                    formatter,
                    "verify artifact for {node} does not cover: {}",
                    missing.join(", ")
                )
            }
            Self::InvalidConfidence(node) => {
                write!(formatter, "verify confidence for {node} is not in 0.0..=1.0")
            }
        }
    }
}

impl std::error::Error for DagValidationError {}

/// Validate a DAG against a preset (§12.1 acceptance).  Runs all structural
/// checks: identity, dependencies, acyclicity, cap, preset shape, and — in
/// `deep` — mandatory honest verify gates for every closed node.
pub fn validate_dag(
    nodes: &[DagNode],
    preset: DagPreset,
) -> Result<(), DagValidationError> {
    if nodes.len() > preset.max_nodes() {
        return Err(DagValidationError::NodeCapExceeded {
            limit: preset.max_nodes(),
        });
    }

    let mut ids = HashSet::new();
    for node in nodes {
        if !ids.insert(node.id.clone()) {
            return Err(DagValidationError::DuplicateNode(node.id.clone()));
        }
    }

    let index: HashMap<&str, &DagNode> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();

    // Structural graph checks run before preset-specific verify gates so a
    // malformed graph reports its shape error, not a downstream gate error.
    for node in nodes {
        if node.dependencies.contains(&node.id) {
            return Err(DagValidationError::SelfDependency(node.id.clone()));
        }
        if !preset.allows_decomposition() && !node.dependencies.is_empty() {
            return Err(DagValidationError::DecompositionInLight {
                node: node.id.clone(),
            });
        }
        for dependency in &node.dependencies {
            if !index.contains_key(dependency.as_str()) {
                return Err(DagValidationError::MissingDependency {
                    node: node.id.clone(),
                    dependency: dependency.clone(),
                });
            }
        }
    }

    assert_acyclic(nodes)?;

    // Verify gates are preset-specific and run only after the graph is known
    // to be acyclic and well-formed.
    for node in nodes {
        if let Some(artifact) = &node.verification {
            validate_artifact(node, artifact)?;
        }
        if node.closed && preset.verify_gates() {
            let Some(artifact) = &node.verification else {
                return Err(DagValidationError::VerifyRequired {
                    node: node.id.clone(),
                });
            };
            if !artifact.is_structurally_honest() {
                return Err(DagValidationError::VerifyNotHonest {
                    node: node.id.clone(),
                });
            }
            // Coverage: every completed dependency must be listed.
            let mut missing = Vec::new();
            for dependency in &node.dependencies {
                let completed = index
                    .get(dependency.as_str())
                    .is_some_and(|dep| dep.status == NodeStatus::Completed);
                if completed && !artifact.verified_nodes.contains(dependency) {
                    missing.push(dependency.clone());
                }
            }
            if !missing.is_empty() {
                return Err(DagValidationError::VerifyIncompleteCoverage {
                    node: node.id.clone(),
                    missing,
                });
            }
        }
    }

    Ok(())
}

fn validate_artifact(node: &DagNode, artifact: &VerifyArtifact) -> Result<(), DagValidationError> {
    if !(0.0..=1.0).contains(&artifact.confidence) {
        return Err(DagValidationError::InvalidConfidence(node.id.clone()));
    }
    Ok(())
}

fn assert_acyclic(nodes: &[DagNode]) -> Result<(), DagValidationError> {
    let index: HashMap<&str, &DagNode> =
        nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    #[derive(Clone, Copy, Eq, PartialEq)]
    enum Mark {
        Visiting,
        Done,
    }
    let mut marks: HashMap<&str, Mark> = HashMap::new();
    fn visit<'a>(
        node: &'a DagNode,
        index: &HashMap<&str, &'a DagNode>,
        marks: &mut HashMap<&'a str, Mark>,
    ) -> Result<(), DagValidationError> {
        match marks.get(node.id.as_str()) {
            Some(Mark::Done) => return Ok(()),
            Some(Mark::Visiting) => return Err(DagValidationError::Cycle { node: node.id.clone() }),
            None => {}
        }
        marks.insert(node.id.as_str(), Mark::Visiting);
        for dependency in &node.dependencies {
            if let Some(dep) = index.get(dependency.as_str()) {
                visit(dep, index, marks)?;
            }
        }
        marks.insert(node.id.as_str(), Mark::Done);
        Ok(())
    }
    for node in nodes {
        visit(node, &index, &mut marks)?;
    }
    Ok(())
}

/// Given a failing verify gate in `deep`, the coordinator spawns a `fix` node
/// (§12.1).  Returns the recommended fix node id + kind; the caller decides the
/// concrete worker assignment.  In `light` there is no gate, so this is `None`.
pub fn fix_node_for(node: &DagNode, preset: DagPreset) -> Option<(String, NodeKind)> {
    if preset.verify_gates() && node.status == NodeStatus::Failed {
        Some((format!("{}:fix", node.id), NodeKind::Implement))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, dependencies: &[&str]) -> DagNode {
        DagNode {
            id: id.to_owned(),
            kind: NodeKind::Implement,
            dependencies: dependencies.iter().map(|dep| dep.to_string()).collect(),
            status: NodeStatus::Completed,
            closed: true,
            verification: None,
        }
    }

    fn honest_artifact(verified: &[&str]) -> VerifyArtifact {
        VerifyArtifact {
            findings: vec!["found one bug".to_owned()],
            evidence: vec!["src/a.rs:12".to_owned()],
            edge_cases: vec!["empty input".to_owned()],
            what_i_did_not_check: vec!["fuzz corpus".to_owned()],
            open_questions: vec!["perf under load".to_owned()],
            confidence: 0.8,
            verified_nodes: verified.iter().map(|id| id.to_string()).collect(),
        }
    }

    #[test]
    fn light_requires_flat_fan_out_and_enforces_cap() {
        let mut nodes = (0..16).map(|index| node(&format!("n{index}"), &[])).collect::<Vec<_>>();
        assert!(validate_dag(&nodes, DagPreset::Light).is_ok());
        nodes.push(node("extra", &[]));
        assert!(matches!(
            validate_dag(&nodes, DagPreset::Light),
            Err(DagValidationError::NodeCapExceeded { limit: 16 })
        ));

        let nested = vec![node("a", &[]), node("b", &["a"])];
        assert!(matches!(
            validate_dag(&nested, DagPreset::Light),
            Err(DagValidationError::DecompositionInLight { .. })
        ));
    }

    #[test]
    fn deep_requires_honest_verify_gate_before_close() {
        let mut unverified = node("impl", &[]);
        unverified.closed = true;
        assert!(matches!(
            validate_dag(&[unverified.clone()], DagPreset::Deep),
            Err(DagValidationError::VerifyRequired { .. })
        ));

        let mut shallow = node("impl", &[]);
        shallow.verification = Some(VerifyArtifact {
            // "All good, no gaps": no verified nodes, no unchecked list.
            confidence: 1.0,
            ..Default::default()
        });
        assert!(matches!(
            validate_dag(&[shallow.clone()], DagPreset::Deep),
            Err(DagValidationError::VerifyNotHonest { .. })
        ));

        let mut honest = node("impl", &[]);
        honest.verification = Some(honest_artifact(&["impl"]));
        assert!(validate_dag(&[honest], DagPreset::Deep).is_ok());
    }

    #[test]
    fn deep_rejects_uncovered_completed_dependencies() {
        let mut child = node("child", &[]);
        child.verification = Some(honest_artifact(&["child"]));
        let mut parent = node("parent", &["child"]);
        parent.verification = Some(honest_artifact(&["parent"])); // missing "child"
        assert!(matches!(
            validate_dag(&[child, parent], DagPreset::Deep),
            Err(DagValidationError::VerifyIncompleteCoverage { .. })
        ));
    }

    #[test]
    fn cycles_and_self_dependencies_are_rejected() {
        let cycle = vec![node("a", &["b"]), node("b", &["a"])];
        assert!(matches!(
            validate_dag(&cycle, DagPreset::Deep),
            Err(DagValidationError::Cycle { .. })
        ));
        let self_dep = vec![node("a", &["a"])];
        assert!(matches!(
            validate_dag(&self_dep, DagPreset::Deep),
            Err(DagValidationError::SelfDependency(_))
        ));
    }

    #[test]
    fn workers_never_spawn_workers_in_either_preset() {
        // The invariant is expressed structurally: node creation is a
        // coordinator-only operation and there is no "spawn" edge type in the
        // model. A node depending on itself or a nonexistent worker id fails.
        let bogus = vec![node("worker-a", &["worker-b"])];
        assert!(matches!(
            validate_dag(&bogus, DagPreset::Deep),
            Err(DagValidationError::MissingDependency { .. })
        ));
    }

    #[test]
    fn fix_node_only_applies_to_failed_deep_nodes() {
        let mut failed = node("impl", &[]);
        failed.status = NodeStatus::Failed;
        assert_eq!(
            fix_node_for(&failed, DagPreset::Deep),
            Some(("impl:fix".to_owned(), NodeKind::Implement))
        );
        assert_eq!(fix_node_for(&failed, DagPreset::Light), None);
        let running = node("impl", &[]);
        assert_eq!(fix_node_for(&running, DagPreset::Deep), None);
    }
}
