use rms_source::{ByteOffset, ByteRange, SourceText};
use rms_syntax::{CstBlockKind, CstDocument, CstKind};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BreakpointSiteKind {
    Command,
    Section,
    Branch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BreakpointSite {
    pub kind: BreakpointSiteKind,
    pub start: ByteOffset,
    pub covers: ByteRange,
    pub owns_until: ByteOffset,
}

fn generating_section(header: &[u8]) -> Option<&'static str> {
    Some(match header {
        b"<LAND_GENERATION>" => "land",
        b"<ELEVATION_GENERATION>" => "elevation",
        b"<CLIFF_GENERATION>" => "cliff",
        b"<TERRAIN_GENERATION>" => "terrain",
        b"<CONNECTION_GENERATION>" => "connection",
        b"<OBJECTS_GENERATION>" => "objects",
        _ => return None,
    })
}

fn runs_as_unit(section: &str, command: &[u8]) -> bool {
    match section {
        "land" | "cliff" => true,
        "elevation" => command == b"create_elevation",
        "terrain" => command == b"create_terrain",
        "connection" => command.starts_with(b"create_connect_"),
        "objects" => command == b"create_object",
        _ => false,
    }
}

pub fn breakpoint_sites(source: &SourceText, cst: &CstDocument) -> Vec<BreakpointSite> {
    let length = ByteOffset(source.bytes().len() as u32);
    let word = |node: &rms_syntax::CstNode| {
        cst.tokens
            .get(node.token_start as usize)
            .map_or(&b""[..], |token| token.bytes(source))
    };
    let section_starts = cst
        .nodes
        .iter()
        .filter(|node| node.kind == CstKind::Section)
        .map(|node| node.range.start)
        .collect::<Vec<_>>();
    let mut commands = Vec::new();
    let mut sections = Vec::new();
    let mut current_section: Option<&'static str> = None;
    for (index, node) in cst.nodes.iter().enumerate() {
        match node.kind {
            CstKind::Section => {
                current_section = generating_section(word(node));
                if current_section.is_some() {
                    let next = section_starts
                        .iter()
                        .copied()
                        .find(|start| *start > node.range.start)
                        .unwrap_or(length);
                    sections.push(BreakpointSite {
                        kind: BreakpointSiteKind::Section,
                        start: node.range.start,
                        covers: ByteRange {
                            start: node.range.start,
                            end: next,
                        },
                        owns_until: node.range.end,
                    });
                }
            }
            CstKind::Command if node.depth == 0 => {
                let Some(section) = current_section else {
                    continue;
                };
                if !runs_as_unit(section, word(node)) {
                    continue;
                }
                let owns_until = cst
                    .nodes
                    .get(index + 1)
                    .filter(|next| next.kind == CstKind::Brace && word(next) == b"{")
                    .and_then(|brace| {
                        cst.brace_pairs
                            .iter()
                            .filter(|pair| pair.start == brace.range.start)
                            .map(|pair| pair.end)
                            .max()
                    })
                    .unwrap_or(node.range.end);
                commands.push(BreakpointSite {
                    kind: BreakpointSiteKind::Command,
                    start: node.range.start,
                    covers: node.range,
                    owns_until,
                });
            }
            _ => {}
        }
    }
    let mut branches = Vec::new();
    for block in &cst.blocks {
        let ranges = match block.kind {
            CstBlockKind::Conditional => block.branches.clone(),
            CstBlockKind::Random => std::iter::once(ByteRange {
                start: block.range.start,
                end: block
                    .branches
                    .last()
                    .map_or(block.range.end, |last| last.end),
            })
            .chain(block.branches.iter().copied())
            .collect(),
        };
        for range in ranges {
            let holds_site = commands
                .iter()
                .chain(&sections)
                .any(|site| range.start < site.start && site.start < range.end);
            if !holds_site {
                continue;
            }
            let keyword_end = cst
                .nodes
                .iter()
                .find(|node| node.range.start == range.start)
                .map_or(range.start, |node| node.range.end);
            branches.push(BreakpointSite {
                kind: BreakpointSiteKind::Branch,
                start: range.start,
                covers: range,
                owns_until: keyword_end,
            });
        }
    }
    let mut sites = commands;
    sites.extend(sections);
    sites.extend(branches);
    sites.sort_by_key(|site| (site.start, site.kind as u8));
    sites.dedup_by_key(|site| site.start);
    sites
}
