//! Minimal Mermaid inline rendering (§13.5).
//!
//! A dependency-free, bounded renderer for `flowchart`/`graph` diagrams: it
//! parses nodes and directed edges into a text transcript that renders in any
//! terminal. Full Kitty/Sixel/halfblock pixel rendering is a later slice and
//! stays out of the base binary. Input is size- and content-bounded, so a
//! malicious or runaway diagram can never blow up the renderer.

use std::fmt;

const MAX_SOURCE_BYTES: usize = 64 * 1024;
const MAX_NODES: usize = 512;
const MAX_EDGES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MermaidNode {
    pub id: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MermaidEdge {
    pub from: String,
    pub to: String,
    pub label: Option<String>,
    pub style: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MermaidDiagram {
    pub direction: String,
    pub nodes: Vec<MermaidNode>,
    pub edges: Vec<MermaidEdge>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MermaidError {
    Empty,
    TooLarge,
    Unsupported(String),
    Parse(String),
    TooManyNodes,
    TooManyEdges,
}

impl fmt::Display for MermaidError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => formatter.write_str("mermaid source is empty"),
            Self::TooLarge => formatter.write_str("mermaid source exceeds the size limit"),
            Self::Unsupported(kind) => {
                write!(
                    formatter,
                    "mermaid diagram type is not supported yet: {kind}"
                )
            }
            Self::Parse(message) => write!(formatter, "mermaid parse error: {message}"),
            Self::TooManyNodes => formatter.write_str("mermaid diagram has too many nodes"),
            Self::TooManyEdges => formatter.write_str("mermaid diagram has too many edges"),
        }
    }
}

impl std::error::Error for MermaidError {}

/// Render a `flowchart`/`graph` mermaid source to a plain-text transcript.
pub fn render_mermaid(source: &str) -> Result<String, MermaidError> {
    let diagram = parse_mermaid(source)?;
    let mut output = String::new();
    output.push_str(&format!("flowchart {}\n", diagram.direction));
    for node in &diagram.nodes {
        match &node.label {
            Some(label) => output.push_str(&format!("  {}: \"{}\"\n", node.id, label)),
            None => output.push_str(&format!("  {}\n", node.id)),
        }
    }
    for edge in &diagram.edges {
        let mut line = format!("  {} {} {}", edge.from, edge.style, edge.to);
        if let Some(label) = &edge.label {
            line.push_str(&format!(" |{label}|"));
        }
        output.push_str(&line);
        output.push('\n');
    }
    Ok(output)
}

/// Parse a `flowchart`/`graph` mermaid source into a typed diagram.
pub fn parse_mermaid(source: &str) -> Result<MermaidDiagram, MermaidError> {
    if source.trim().is_empty() {
        return Err(MermaidError::Empty);
    }
    if source.len() > MAX_SOURCE_BYTES {
        return Err(MermaidError::TooLarge);
    }
    if source
        .chars()
        .any(|character| (character as u32) < 0x20 && character != '\n' && character != '\t')
    {
        return Err(MermaidError::Parse(
            "control characters are not allowed".to_owned(),
        ));
    }

    let mut direction = "TD".to_owned();
    let mut nodes: Vec<MermaidNode> = Vec::new();
    let mut edges: Vec<MermaidEdge> = Vec::new();
    let mut diagram_kind: Option<String> = None;

    for raw in source.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with("%%") {
            continue;
        }
        if line == "subgraph" || line.starts_with("subgraph ") || line == "end" {
            continue; // subgraphs are accepted but not laid out separately
        }
        let (first, _) = line.split_once(' ').map_or((line, ""), |pair| pair);
        if let Some(kind) = diagram_kind.as_deref() {
            if matches!(kind, "flowchart" | "graph") {
                parse_flowchart_line(line, first, &mut direction, &mut nodes, &mut edges)?;
            } else {
                return Err(MermaidError::Unsupported(kind.to_owned()));
            }
        } else {
            // First significant line must declare the diagram type.
            match first {
                "flowchart" | "graph" => {
                    diagram_kind = Some(first.to_owned());
                    if let Some(dir) = direction_of(line[first.len()..].trim()) {
                        direction = dir.to_owned();
                    }
                }
                other => return Err(MermaidError::Unsupported(other.to_owned())),
            }
        }
        if nodes.len() > MAX_NODES {
            return Err(MermaidError::TooManyNodes);
        }
        if edges.len() > MAX_EDGES {
            return Err(MermaidError::TooManyEdges);
        }
    }

    if diagram_kind.is_none() {
        return Err(MermaidError::Unsupported("(no diagram type)".to_owned()));
    }
    Ok(MermaidDiagram {
        direction,
        nodes,
        edges,
    })
}

fn direction_of(value: &str) -> Option<&str> {
    ["TD", "LR", "RL", "BT", "TB"]
        .into_iter()
        .find(|dir| value == *dir || value.starts_with(dir))
}

fn parse_flowchart_line(
    line: &str,
    first: &str,
    direction: &mut String,
    nodes: &mut Vec<MermaidNode>,
    edges: &mut Vec<MermaidEdge>,
) -> Result<(), MermaidError> {
    if let Some(dir) = direction_of(first) {
        *direction = dir.to_owned();
        return Ok(());
    }
    // An edge line contains a connector (-->, ---, -.->, ==>, <-->).
    if let Some((from, rest)) = split_edge(line) {
        for (to, label) in edge_targets(rest) {
            let (from_id, from_label) = node_parts(from.trim());
            push_node(nodes, from_id.clone(), from_label);
            let (to_id, to_label) = node_parts(to.trim());
            push_node(nodes, to_id.clone(), to_label);
            edges.push(MermaidEdge {
                from: from_id,
                to: to_id,
                label,
                style: edge_style(line),
            });
        }
        return Ok(());
    }
    // A bare node declaration: `id[Label]`, `id(Label)`, `id{Label}`, or `id`.
    let (id, label) = node_parts(line);
    push_node(nodes, id, label);
    Ok(())
}

fn split_edge(line: &str) -> Option<(&str, &str)> {
    for connector in ["<-->", "-.->", "==>", "-->", "---", "-.-"] {
        if let Some(index) = line.find(connector) {
            let from = &line[..index];
            let rest = &line[index + connector.len()..];
            return Some((from, rest));
        }
    }
    None
}

fn edge_style(line: &str) -> String {
    for connector in ["<-->", "-.->", "==>", "-->", "---"] {
        if line.contains(connector) {
            return connector.to_owned();
        }
    }
    "-->".to_owned()
}

/// Split `B & C` chains and `B -->|label|` labels into target+label pairs.
fn edge_targets(rest: &str) -> Vec<(String, Option<String>)> {
    let (rest, label) = if let Some(open) = rest.find('|') {
        let after = &rest[open + 1..];
        match after.find('|') {
            Some(close) => (&after[close + 1..], Some(after[..close].trim().to_owned())),
            None => (rest, None),
        }
    } else {
        (rest, None)
    };
    let mut targets = Vec::new();
    for part in rest.split('&') {
        let target = part.trim();
        if !target.is_empty() {
            targets.push((target.to_owned(), label.clone()));
        }
    }
    targets
}

/// Split a node token into `(id, optional label)`, stripping bracket shapes.
fn node_parts(token: &str) -> (String, Option<String>) {
    let token = token.trim();
    if token.is_empty() {
        return (String::new(), None);
    }
    // `id[Label]`, `id(Label)`, `id{Label}`, `id>Label]`, `id((Label))`.
    if let Some(index) = token.find(['[', '(', '{', '>']) {
        let id = token[..index].trim().to_owned();
        if id.is_empty() {
            return (token.to_owned(), None);
        }
        let mut label =
            token[index..].trim_matches(|c| matches!(c, '[' | ']' | '(' | ')' | '{' | '}' | '>'));
        label = label.trim();
        return (id, Some(label.to_owned()));
    }
    (token.to_owned(), None)
}

fn push_node(nodes: &mut Vec<MermaidNode>, id: String, label: Option<String>) {
    if id.is_empty() {
        return;
    }
    if let Some(existing) = nodes.iter_mut().find(|node| node.id == id) {
        if existing.label.is_none() && label.is_some() {
            existing.label = label;
        }
        return;
    }
    nodes.push(MermaidNode { id, label });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_simple_flowchart() {
        let source = "flowchart LR\n  A[Start] --> B[End]";
        let diagram = parse_mermaid(source).unwrap();
        assert_eq!(diagram.direction, "LR");
        assert_eq!(diagram.nodes.len(), 2);
        assert_eq!(diagram.edges.len(), 1);
        assert_eq!(diagram.edges[0].from, "A");
        assert_eq!(diagram.edges[0].to, "B");
    }

    #[test]
    fn renders_nodes_and_labeled_edges() {
        let source = "graph TD\n  A -->|yes| B & C";
        let rendered = render_mermaid(source).unwrap();
        assert!(rendered.contains("flowchart TD"));
        assert!(rendered.contains("A --> B |yes|"));
        assert!(rendered.contains("A --> C |yes|"));
    }

    #[test]
    fn rejects_unsupported_types_and_huge_input() {
        assert!(matches!(
            parse_mermaid("sequenceDiagram\n  Alice->>Bob: hi"),
            Err(MermaidError::Unsupported(_))
        ));
        let huge = "flowchart TD\n".to_owned() + &"A --> B\n".repeat(100_000);
        assert!(matches!(parse_mermaid(&huge), Err(MermaidError::TooLarge)));
    }

    #[test]
    fn rejects_empty_and_control_characters() {
        assert!(matches!(parse_mermaid(""), Err(MermaidError::Empty)));
        assert!(matches!(
            parse_mermaid("flowchart TD\nA\u{0}--> B"),
            Err(MermaidError::Parse(_))
        ));
    }

    #[test]
    fn deduplicates_nodes_and_keeps_first_label() {
        let source = "flowchart TD\n  A --> B\n  A[Real Label] --> C";
        let diagram = parse_mermaid(source).unwrap();
        let a = diagram.nodes.iter().find(|node| node.id == "A").unwrap();
        assert_eq!(a.label.as_deref(), Some("Real Label"));
    }
}
