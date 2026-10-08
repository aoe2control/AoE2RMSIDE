use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use rms_analysis::{ContentKind, content_slot};
use rms_content::packaged_support_bundles;
use rms_engine::LOBBY_LABELS;
use rms_profile::{ConstantKind, frozen_constant_kinds};
use rms_semantics::{
    CommandRules, ObjectBlockCommandEffect, StrictArgumentKind, StrictCommand, StrictCommandKind,
    block_rules, descriptor_block, is_global_descriptor_command, is_player_setup_command,
    object_block_command_effect, opens_descriptor_block, section_rules, strict_command,
    strict_commands,
};
use rms_source::{ByteOffset, IncludePath, SourceCatalogOrigin, SourceCatalogRole, SourceText};
use rms_syntax::{Token, TokenKind};
use serde_json::{Value, json};

use crate::{OpenDocument, RequestResult, Server, byte_offset, include_syntax, request_position};

pub(crate) const MAXIMUM_INCLUDE_CLOSURE: usize = 256;
const MAXIMUM_OPENER_LOOKBACK: usize = 8;
const MAXIMUM_INCLUDE_FILES: usize = 1_000;

const NAMED_SLOTS: &[(&str, usize, ConstantKind)] = &[
    ("assign_to", 0, ConstantKind::AssignType),
    ("color_correction", 0, ConstantKind::ColorCorrection),
    ("ai_info_map_type", 0, ConstantKind::MapType),
    ("effect_amount", 0, ConstantKind::Effect),
    ("effect_percent", 0, ConstantKind::Effect),
    ("water_definition", 0, ConstantKind::WaterDefinition),
    ("set_gaia_civilization", 0, ConstantKind::Civilization),
];

fn named_slot_kind(command: &str, index: usize) -> Option<ConstantKind> {
    NAMED_SLOTS
        .iter()
        .find(|(name, slot, _)| *name == command && *slot == index)
        .map(|(_, _, kind)| *kind)
}

const KIND_FUNCTION: u8 = 3;
const KIND_PROPERTY: u8 = 10;
const KIND_KEYWORD: u8 = 14;
const KIND_FILE: u8 = 17;
const KIND_FOLDER: u8 = 19;
const KIND_CONSTANT: u8 = 21;

const SORT_POSITION: &str = "0";
const SORT_GLOBAL: &str = "1";
const SORT_CONTROL: &str = "2";
const SORT_DIRECTIVE: &str = "3";
const SORT_SECTION: &str = "4";

const CONTROL_TERMS: &[&str] = &[
    "if",
    "elseif",
    "else",
    "endif",
    "start_random",
    "percent_chance",
    "end_random",
];

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum CaretContext {
    Inside,
    Statement {
        word: String,
        block: Block,
    },
    Operand {
        head: &'static StrictCommand,
        index: usize,
        word: String,
    },
}

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum Block {
    TopLevel,
    Inside(Option<&'static str>),
}

pub(crate) fn caret_context(
    source: &SourceText,
    tokens: &[Token],
    offset: ByteOffset,
) -> CaretContext {
    caret_position(source, tokens, offset).0
}

fn caret_position(
    source: &SourceText,
    tokens: &[Token],
    offset: ByteOffset,
) -> (CaretContext, usize) {
    let bytes = source.bytes();
    let text = |token: &Token| {
        std::str::from_utf8(&bytes[token.range.start.0 as usize..token.range.end.0 as usize])
            .unwrap_or("")
    };
    let index = tokens.partition_point(|token| token.range.end < offset);
    let (word, before_end) = match tokens.get(index) {
        Some(token) if token.range.start < offset => match token.kind {
            TokenKind::LineComment | TokenKind::BlockComment => {
                return (CaretContext::Inside, index);
            }
            TokenKind::String => {
                let context = quoted_path_operand(tokens, index, offset, &text, bytes).map_or(
                    CaretContext::Inside,
                    |(head, word)| CaretContext::Operand {
                        head,
                        index: 0,
                        word,
                    },
                );
                return (context, index);
            }
            TokenKind::Whitespace
            | TokenKind::Newline
            | TokenKind::Bom
            | TokenKind::LBrace
            | TokenKind::RBrace => (String::new(), index + 1),
            _ => (
                String::from_utf8_lossy(&bytes[token.range.start.0 as usize..offset.0 as usize])
                    .into_owned(),
                index,
            ),
        },
        _ => (String::new(), index),
    };
    let mut line = Vec::new();
    for token in tokens[..before_end.min(tokens.len())].iter().rev() {
        if token.kind == TokenKind::Newline {
            break;
        }
        if !token.kind.is_trivia() {
            line.push(token);
        }
    }
    line.reverse();
    if let Some((head, path)) = path_operand(&line, &word, offset, &text, bytes) {
        return (
            CaretContext::Operand {
                head,
                index: 0,
                word: path,
            },
            before_end,
        );
    }
    let mut open: Option<(&'static StrictCommand, usize)> = None;
    for token in &line {
        if matches!(token.kind, TokenKind::LBrace | TokenKind::RBrace) {
            open = None;
            continue;
        }
        match open.as_mut() {
            Some((_, operands)) => *operands += 1,
            None => {
                open = strict_command(text(token)).map(|command| (command, 0));
            }
        }
        if let Some((command, operands)) = open
            && operands >= command.arguments.len()
        {
            open = None;
        }
    }
    let context = match open {
        Some((head, index)) => CaretContext::Operand { head, index, word },
        None => CaretContext::Statement {
            word,
            block: block_at(tokens, before_end, &text).0,
        },
    };
    (context, before_end)
}

fn path_operand<'t>(
    line: &[&'t Token],
    word: &str,
    offset: ByteOffset,
    text: &impl Fn(&'t Token) -> &'t str,
    bytes: &[u8],
) -> Option<(&'static StrictCommand, String)> {
    let directive = line.iter().rposition(|token| {
        strict_command(text(token))
            .is_some_and(|command| command.arguments.first() == Some(&StrictArgumentKind::Path))
    })?;
    let head = strict_command(text(line[directive]))?;
    let word_start = offset.0.checked_sub(u32::try_from(word.len()).ok()?)?;
    let mut start = word_start;
    for token in line[directive + 1..].iter().rev() {
        if token.range.end.0 != start {
            return None;
        }
        start = token.range.start.0;
    }
    if start == line[directive].range.end.0 {
        return None;
    }
    let path = String::from_utf8_lossy(bytes.get(start as usize..offset.0 as usize)?).into_owned();
    Some((head, path))
}

fn quoted_path_operand<'t>(
    tokens: &'t [Token],
    index: usize,
    offset: ByteOffset,
    text: &impl Fn(&'t Token) -> &'t str,
    bytes: &[u8],
) -> Option<(&'static StrictCommand, String)> {
    let quoted = tokens.get(index)?;
    let mut before = tokens[..index].iter().rev();
    let directive = before.find(|token| {
        !matches!(
            token.kind,
            TokenKind::Whitespace | TokenKind::BlockComment | TokenKind::Bom
        )
    })?;
    let head = strict_command(text(directive))
        .filter(|command| command.arguments.first() == Some(&StrictArgumentKind::Path))?;
    if directive.range.end == quoted.range.start {
        return None;
    }
    let path = bytes.get(quoted.range.start.0 as usize..offset.0 as usize)?;
    Some((head, String::from_utf8_lossy(path).into_owned()))
}

fn block_at<'t>(
    tokens: &'t [Token],
    index: usize,
    text: &impl Fn(&'t Token) -> &'t str,
) -> (Block, Option<usize>) {
    let mut depth = 0_usize;
    let mut found = None;
    for (position, token) in tokens[..index.min(tokens.len())].iter().enumerate().rev() {
        match token.kind {
            TokenKind::RBrace => depth += 1,
            TokenKind::LBrace if depth == 0 => {
                found = Some(position);
                break;
            }
            TokenKind::LBrace => depth -= 1,
            TokenKind::Section => break,
            _ => {}
        }
    }
    let Some(brace) = found else {
        return (Block::TopLevel, None);
    };
    let preceding = tokens[..brace]
        .iter()
        .rev()
        .filter(|token| !token.kind.is_trivia())
        .take_while(|token| !matches!(token.kind, TokenKind::LBrace | TokenKind::RBrace))
        .take(MAXIMUM_OPENER_LOOKBACK)
        .collect::<Vec<_>>();
    let opener = preceding.iter().enumerate().find_map(|(operands, token)| {
        strict_command(text(token))
            .filter(|command| {
                command.kind == StrictCommandKind::Descriptor && command.arguments.len() == operands
            })
            .map(|command| command.name)
    });
    (Block::Inside(opener), Some(brace))
}

type Branch = (u32, u32);

#[derive(Debug)]
struct Statement {
    name: &'static str,
    branches: Vec<Branch>,
    after_caret: bool,
}

#[derive(Debug, Default)]
struct Scan {
    statements: Vec<Statement>,
    caret: Vec<Branch>,
}

impl Scan {
    fn runs_with_caret(&self, statement: &Statement) -> bool {
        statement.branches.iter().all(|(construct, branch)| {
            self.caret
                .iter()
                .all(|(other, other_branch)| other != construct || other_branch == branch)
        })
    }

    fn uses(&self, name: &str) -> bool {
        self.statements
            .iter()
            .any(|statement| statement.name == name && self.runs_with_caret(statement))
    }

    fn uses_after_caret(&self, name: &str) -> bool {
        self.statements.iter().any(|statement| {
            statement.name == name && statement.after_caret && self.runs_with_caret(statement)
        })
    }

    fn admits(&self, rules: &CommandRules, name: &str) -> bool {
        if !rules.is_repeatable(name) && self.uses(name) {
            return false;
        }
        if rules.exclusive_with(name).any(|other| self.uses(other)) {
            return false;
        }
        if rules
            .overriding(name)
            .iter()
            .any(|later| self.uses_after_caret(later))
        {
            return false;
        }
        [rules.required_by(name), rules.enabled_by(name)]
            .iter()
            .all(|needed| needed.is_empty() || needed.iter().any(|other| self.uses(other)))
    }
}

fn scan_region<'t>(
    tokens: &'t [Token],
    start: usize,
    offset: ByteOffset,
    block: bool,
    text: &impl Fn(&'t Token) -> &'t str,
) -> Scan {
    let mut scan = Scan::default();
    let mut caret = None;
    let mut constructs = Vec::<(Branch, bool)>::new();
    let mut next_construct = 0_u32;
    let mut depth = 0_usize;
    let mut operands: &[StrictArgumentKind] = &[];
    for token in tokens.iter().skip(start) {
        if token.kind.is_trivia() {
            continue;
        }
        match token.kind {
            TokenKind::Section => break,
            TokenKind::LBrace => {
                depth += 1;
                operands = &[];
                continue;
            }
            TokenKind::RBrace => {
                if depth == 0 {
                    if block {
                        break;
                    }
                } else {
                    depth -= 1;
                }
                operands = &[];
                continue;
            }
            _ => {}
        }
        if depth > 0 {
            continue;
        }
        let word = text(token);
        let command = strict_command(word);
        if let Some((kind, rest)) = operands.split_first() {
            if !(*kind == StrictArgumentKind::TolerantNumber && command.is_some()) {
                operands = rest;
                continue;
            }
            operands = &[];
        }
        let Some(command) = command else {
            continue;
        };
        let contains_caret = token.range.start <= offset && offset <= token.range.end;
        if caret.is_none() && (token.range.start >= offset || contains_caret) {
            caret = Some(constructs.iter().map(|(branch, _)| *branch).collect());
        }
        operands = command.arguments;
        match command.name {
            "if" | "start_random" => {
                constructs.push(((next_construct, 0), command.name == "if"));
                next_construct += 1;
            }
            "elseif" | "else" | "percent_chance" => {
                let conditional = command.name != "percent_chance";
                if let Some(((_, branch), is_conditional)) = constructs.last_mut()
                    && *is_conditional == conditional
                {
                    *branch += 1;
                }
            }
            "endif" | "end_random" => {
                if constructs
                    .last()
                    .is_some_and(|(_, conditional)| *conditional == (command.name == "endif"))
                {
                    constructs.pop();
                }
            }
            _ if command.kind == StrictCommandKind::Descriptor && !contains_caret => {
                scan.statements.push(Statement {
                    name: command.name,
                    branches: constructs.iter().map(|(branch, _)| *branch).collect(),
                    after_caret: token.range.start >= offset,
                });
            }
            _ => {}
        }
    }
    scan.caret = caret.unwrap_or_else(|| constructs.iter().map(|(branch, _)| *branch).collect());
    scan
}

struct StatementPosition {
    rules: Option<&'static CommandRules>,
    block: Block,
    scan: Scan,
    section: String,
    open_control: Option<Control>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Control {
    Conditional,
    Random,
}

fn open_control(source: &SourceText, tokens: &[Token], index: usize) -> Option<Control> {
    let mut open = Vec::new();
    for token in &tokens[..index.min(tokens.len())] {
        if token.kind != TokenKind::Identifier {
            continue;
        }
        match token.bytes(source) {
            b"if" => open.push(Control::Conditional),
            b"start_random" => open.push(Control::Random),
            b"endif" if open.last() == Some(&Control::Conditional) => {
                open.pop();
            }
            b"end_random" if open.last() == Some(&Control::Random) => {
                open.pop();
            }
            _ => {}
        }
    }
    open.last().copied()
}

fn control_term_fits(term: &str, open: Option<Control>) -> bool {
    match term {
        "elseif" | "else" | "endif" => open == Some(Control::Conditional),
        "percent_chance" | "end_random" => open == Some(Control::Random),
        _ => true,
    }
}

fn statement_position(
    source: &SourceText,
    tokens: &[Token],
    offset: ByteOffset,
    index: usize,
    block: Block,
    section: String,
) -> StatementPosition {
    let bytes = source.bytes();
    let text = |token: &Token| {
        std::str::from_utf8(&bytes[token.range.start.0 as usize..token.range.end.0 as usize])
            .unwrap_or("")
    };
    let (rules, scan) = match &block {
        Block::Inside(opener) => {
            let rules = opener.and_then(descriptor_block).map(block_rules);
            let brace = block_at(tokens, index, &text).1;
            let scan = brace.map_or_else(Scan::default, |brace| {
                scan_region(tokens, brace + 1, offset, true, &text)
            });
            (rules, scan)
        }
        Block::TopLevel => {
            let start = tokens[..index.min(tokens.len())]
                .iter()
                .rposition(|token| token.kind == TokenKind::Section)
                .map_or(0, |header| header + 1);
            let rules = section_rules(&section);
            (rules, scan_region(tokens, start, offset, false, &text))
        }
    };
    StatementPosition {
        rules,
        block,
        scan,
        section,
        open_control: open_control(source, tokens, index),
    }
}

fn triggered_by(params: &Value, character: &str) -> bool {
    params
        .pointer("/context/triggerKind")
        .and_then(Value::as_u64)
        == Some(2)
        && params
            .pointer("/context/triggerCharacter")
            .and_then(Value::as_str)
            == Some(character)
}

fn desktop_names_content(params: &Value, kind: ContentKind) -> bool {
    let field = match kind {
        ContentKind::Object => "/rmsContext/localObjectNames",
        ContentKind::Terrain => "/rmsContext/localTerrainNames",
    };
    params.pointer(field).and_then(Value::as_bool) == Some(true)
}

struct Definition {
    name: String,
    constant: bool,
    value: Option<String>,
    here: bool,
}

fn slot_usage(documents: &[&OpenDocument]) -> BTreeMap<String, ContentKind> {
    let mut usage = BTreeMap::<String, Option<ContentKind>>::new();
    for document in documents {
        for node in &document.analysis.cst.nodes {
            let mut tokens = document.analysis.cst.tokens
                [node.token_start as usize..node.token_end as usize]
                .iter()
                .filter(|token| !token.kind.is_trivia());
            let Some(head) = tokens.next() else {
                continue;
            };
            let head = String::from_utf8_lossy(head.bytes(&document.source));
            for (index, operand) in tokens.enumerate() {
                if operand.kind != TokenKind::Identifier {
                    continue;
                }
                let Some(kind) = content_slot(&head, index) else {
                    continue;
                };
                let name = String::from_utf8_lossy(operand.bytes(&document.source)).into_owned();
                usage
                    .entry(name)
                    .and_modify(|existing| {
                        if *existing != Some(kind) {
                            *existing = None;
                        }
                    })
                    .or_insert(Some(kind));
            }
        }
    }
    usage
        .into_iter()
        .filter_map(|(name, kind)| kind.map(|kind| (name, kind)))
        .collect()
}

fn definitions(documents: &[&OpenDocument]) -> Vec<Definition> {
    let mut found = BTreeMap::<String, Definition>::new();
    for (position, document) in documents.iter().enumerate() {
        for definition in crate::rms_navigation::definition_tokens(document) {
            let text =
                |token: &Token| String::from_utf8_lossy(token.bytes(&document.source)).into_owned();
            let name = text(definition.name);
            found.entry(name.clone()).or_insert(Definition {
                name,
                constant: definition.constant,
                value: definition.value.map(text),
                here: position == 0,
            });
        }
    }
    found.into_values().collect()
}

struct ContentIdentities {
    identity: String,
    objects: BTreeSet<i64>,
    terrains: BTreeSet<i64>,
    kinds: Option<BTreeMap<String, ConstantKind>>,
}

impl ContentIdentities {
    fn names(&self, kind: ContentKind, name: &str, value: &str) -> bool {
        let (wanted, identities) = match kind {
            ContentKind::Object => (ConstantKind::Object, &self.objects),
            ContentKind::Terrain => (ConstantKind::Terrain, &self.terrains),
        };
        match self.kinds.as_ref().and_then(|kinds| kinds.get(name)) {
            Some(found) => *found == wanted,
            None => value
                .parse::<i64>()
                .is_ok_and(|value| identities.contains(&value)),
        }
    }

    fn kind_of(&self, name: &str) -> Option<ConstantKind> {
        self.kinds.as_ref()?.get(name).copied()
    }
}

fn packaged_kinds(bundle: &rms_content::SupportBundle) -> Option<BTreeMap<String, ConstantKind>> {
    let document = frozen_constant_kinds(&bundle.manifest.behavior_profile_id).ok()??;
    let entry = document.entry(&bundle.manifest.product_version)?;
    (entry.provenance.definitions_sha256 == bundle.manifest.implicit_definitions.file_sha256).then(
        || {
            entry
                .names
                .iter()
                .map(|named| (named.name.clone(), named.kind))
                .collect()
        },
    )
}

fn packaged_identities() -> &'static [ContentIdentities] {
    static IDENTITIES: OnceLock<Vec<ContentIdentities>> = OnceLock::new();
    IDENTITIES.get_or_init(|| {
        packaged_support_bundles()
            .map(|bundles| {
                bundles
                    .iter()
                    .map(|bundle| ContentIdentities {
                        kinds: packaged_kinds(bundle),
                        identity: format!(
                            "{}@{}#{}",
                            bundle.content.pack_id,
                            bundle.content.pack_version,
                            bundle.content.source.fingerprint
                        ),
                        objects: bundle
                            .content
                            .objects
                            .iter()
                            .map(|object| i64::from(object.id.0))
                            .collect(),
                        terrains: bundle
                            .content
                            .terrains
                            .iter()
                            .map(|terrain| i64::from(terrain.id.0))
                            .collect(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    })
}

fn packaged_vocabulary() -> &'static BTreeMap<String, String> {
    static VOCABULARY: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    VOCABULARY.get_or_init(|| {
        packaged_support_bundles()
            .ok()
            .and_then(|bundles| bundles.first())
            .and_then(|bundle| bundle.vocabulary().ok())
            .unwrap_or_default()
    })
}

pub(crate) fn standard_include_names(profile_id: Option<&str>) -> Vec<String> {
    let Ok(bundles) = packaged_support_bundles() else {
        return Vec::new();
    };
    profile_id
        .and_then(|profile| {
            bundles
                .iter()
                .find(|bundle| bundle.manifest.behavior_profile_id == profile)
        })
        .or_else(|| bundles.first())
        .map(|bundle| bundle.standard_includes.standard_includes.clone())
        .unwrap_or_default()
}

fn item(label: &str, kind: u8, detail: Option<String>, sort: &str) -> Value {
    let mut value = json!({
        "label": label,
        "kind": kind,
        "sortText": format!("{sort}{label}"),
    });
    if let Some(detail) = detail {
        value["detail"] = json!(detail);
    }
    value
}

fn fits_unknown_block(command: &StrictCommand) -> bool {
    command.kind == StrictCommandKind::Descriptor
        && !opens_descriptor_block(command.name)
        && command.name != "create_actor_area"
        && !is_player_setup_command(command.name)
        && object_block_command_effect(command.name) != ObjectBlockCommandEffect::GroupEntry
}

fn statement_sort(command: &StrictCommand, position: &StatementPosition) -> Option<&'static str> {
    if command.kind != StrictCommandKind::Descriptor {
        return None;
    }
    if is_global_descriptor_command(command.name) {
        return Some(SORT_GLOBAL);
    }
    match (position.rules, &position.block) {
        (Some(rules), _) => (rules.contains(command.name)
            && position.scan.admits(rules, command.name))
        .then_some(SORT_POSITION),
        (None, Block::Inside(_)) => fits_unknown_block(command).then_some(SORT_POSITION),
        (None, Block::TopLevel) => None,
    }
}

fn statement_items(word: &str, position: &StatementPosition) -> Vec<Value> {
    let mut items = Vec::new();
    let sections_only = word.starts_with('<');
    let directives_only = word.starts_with('#');
    if !directives_only && position.block == Block::TopLevel {
        for command in strict_commands() {
            if let StrictCommandKind::Section(_) = command.kind {
                items.push(item(command.name, KIND_KEYWORD, None, SORT_SECTION));
            }
        }
    }
    if sections_only {
        return items;
    }
    for command in strict_commands() {
        if command.name.starts_with('#') {
            items.push(item(command.name, KIND_KEYWORD, None, SORT_DIRECTIVE));
            continue;
        }
        if directives_only {
            continue;
        }
        let Some(sort) = statement_sort(command, position) else {
            continue;
        };
        let creates = command.name.starts_with("create_");
        items.push(item(
            command.name,
            if creates {
                KIND_FUNCTION
            } else {
                KIND_PROPERTY
            },
            None,
            sort,
        ));
    }
    if directives_only {
        return items;
    }
    for term in CONTROL_TERMS
        .iter()
        .filter(|term| control_term_fits(term, position.open_control))
    {
        items.push(item(term, KIND_KEYWORD, None, SORT_CONTROL));
    }
    items.extend(crate::rms_docs::snippet_items(
        &position.block,
        &position.section,
        SORT_CONTROL,
    ));
    items
}

fn virtual_folder(path: &str) -> Option<&str> {
    path.rsplit_once('/').map(|(folder, _)| folder)
}

fn relative_to<'p>(path: &'p str, root: &str, case_sensitive: bool) -> Option<&'p str> {
    let prefix = path.get(..root.len())?;
    let same = if case_sensitive {
        prefix == root
    } else {
        prefix.eq_ignore_ascii_case(root)
    };
    (same && path.as_bytes().get(root.len()) == Some(&b'/')).then(|| &path[root.len() + 1..])
}

fn within(path: &str, root: &str, case_sensitive: bool) -> bool {
    let same = if case_sensitive {
        path == root
    } else {
        path.eq_ignore_ascii_case(root)
    };
    same || relative_to(path, root, case_sensitive).is_some()
}

fn browse(base: &str, segments: &[String]) -> Option<String> {
    let mut folder = base.to_owned();
    for segment in segments {
        match segment.as_str() {
            "." => {}
            ".." => folder = virtual_folder(&folder)?.to_owned(),
            name => {
                folder.push('/');
                folder.push_str(name);
            }
        }
    }
    Some(folder)
}

struct TypedPath {
    quote: Option<char>,
    closed: bool,
    folder: String,
    segments: Vec<String>,
    name: String,
    dotted: bool,
    followable: bool,
}

impl TypedPath {
    fn new(word: &str, after: &[u8]) -> Self {
        let quote = word
            .chars()
            .next()
            .filter(|first| matches!(first, '"' | '\''));
        let body = word[quote.map_or(0, char::len_utf8)..].replace('\\', "/");
        let (folder, name) = match body.rfind('/') {
            Some(end) => (body[..=end].to_owned(), body[end + 1..].to_owned()),
            None => (String::new(), body.clone()),
        };
        let segments = folder
            .strip_suffix('/')
            .map(|folder| folder.split('/').map(str::to_owned).collect::<Vec<_>>())
            .unwrap_or_default();
        let line = after
            .iter()
            .take_while(|byte| !matches!(byte, b'\r' | b'\n'))
            .copied()
            .collect::<Vec<_>>();
        Self {
            quote,
            closed: quote.is_some_and(|quote| line.contains(&(quote as u8))),
            followable: !folder.contains(':') && segments.iter().all(|segment| !segment.is_empty()),
            dotted: segments
                .iter()
                .any(|segment| segment == "." || segment == ".."),
            folder,
            segments,
            name,
        }
    }

    fn path_length(&self) -> usize {
        self.folder.len() + self.name.len()
    }

    fn file_text(&self, path: &str) -> String {
        match self.quote {
            Some(_) if self.closed => path.to_owned(),
            Some(quote) => format!("{path}{quote}"),
            None if path.contains(' ') => format!("\"{path}\""),
            None => path.to_owned(),
        }
    }

    fn file_item(&self, name: &str, written: &str, ranges: &PathRanges) -> Value {
        let mut value = item(name, KIND_FILE, Some("workspace file".to_owned()), "0");
        let typed = format!("{}{name}", self.folder);
        if written == typed && !(self.quote.is_none() && written.contains(' ')) {
            value["textEdit"] = json!({ "range": ranges.name, "newText": self.file_text(name) });
        } else {
            if written != typed {
                value["detail"] = json!(format!("workspace file · written as {written}"));
            }
            value["filterText"] = json!(typed);
            value["textEdit"] = json!({ "range": ranges.path, "newText": self.file_text(written) });
        }
        value
    }

    fn folder_item(&self, name: &str, ranges: &PathRanges) -> Value {
        let label = format!("{name}/");
        let mut value = item(&label, KIND_FOLDER, Some("folder".to_owned()), "0");
        if self.quote.is_none() && name.contains(' ') {
            let typed = format!("{}{label}", self.folder);
            value["filterText"] = json!(typed);
            value["textEdit"] = json!({ "range": ranges.path, "newText": format!("\"{typed}") });
        } else {
            value["textEdit"] = json!({ "range": ranges.name, "newText": label });
        }
        value["command"] = json!({
            "title": "Suggest",
            "command": "editor.action.triggerSuggest",
        });
        value
    }
}

struct PathRanges {
    path: Value,
    name: Value,
}

#[derive(Default)]
struct IncludeLevel {
    items: Vec<Value>,
    written: BTreeSet<String>,
}

impl Server {
    fn completion_documents<'a>(
        &'a self,
        uri: &str,
        document: &'a OpenDocument,
    ) -> Vec<&'a OpenDocument> {
        self.include_closure(uri, document)
            .into_iter()
            .map(|(_, found)| found)
            .collect()
    }

    pub(crate) fn vocabulary(&self) -> &BTreeMap<String, String> {
        match self.editor_selection() {
            Some(catalog) => catalog.implicit_definitions(),
            None => packaged_vocabulary(),
        }
    }

    fn content_identities(&self) -> Option<&'static ContentIdentities> {
        let identities = packaged_identities();
        match self.editor_selection() {
            Some(catalog) => identities
                .iter()
                .find(|identities| identities.identity == catalog.content_identity()),
            None => identities.first(),
        }
    }

    fn cliff_types(&self) -> Vec<&str> {
        let kinds = self
            .content_identities()
            .and_then(|identities| identities.kinds.as_ref());
        let mut found = self
            .vocabulary()
            .iter()
            .filter(|(name, _)| match kinds {
                Some(kinds) => kinds.get(name.as_str()) == Some(&ConstantKind::CliffType),
                None => name.starts_with("CT_"),
            })
            .map(|(name, value)| {
                let value = value.trim().parse::<i64>().unwrap_or(i64::MAX);
                (value, name.as_str())
            })
            .collect::<Vec<_>>();
        found.sort_unstable();
        found.into_iter().map(|(_, name)| name).collect()
    }

    pub(crate) fn run_setting_labels(&self) -> BTreeMap<String, String> {
        self.preview_context
            .setup
            .lobby_implicit_definitions(
                &self.preview_context.map_size,
                &self.preview_context.players,
            )
            .unwrap_or_default()
    }

    pub(crate) fn rms_completion(&self, params: &Value) -> RequestResult<Value> {
        let (uri, position) = request_position(params)?;
        let document = self.document(uri)?;
        let offset = byte_offset(&document.source, position)?;
        let space = triggered_by(params, " ");
        let slash = triggered_by(params, "/");
        let tokens = &document.analysis.cst.tokens;
        let (context, index) = caret_position(&document.source, tokens, offset);
        let empty = || json!({ "isIncomplete": false, "items": [] });
        let (head, index, word) = match context {
            CaretContext::Inside => return Ok(empty()),
            CaretContext::Statement { word, block } => {
                if space || slash {
                    return Ok(empty());
                }
                let section = crate::section_at(document, offset);
                let position =
                    statement_position(&document.source, tokens, offset, index, block, section);
                return Ok(json!({
                    "isIncomplete": false,
                    "items": statement_items(&word, &position),
                }));
            }
            CaretContext::Operand { head, index, word } => (head, index, word),
        };
        let argument = head.arguments[index];
        if slash && (argument != StrictArgumentKind::Path || head.name != "#include") {
            return Ok(empty());
        }
        let content = content_slot(head.name, index);
        let mut items = Vec::new();
        let mut defaults = None;
        match (content, argument) {
            (Some(kind), _) => {
                let documents = self.completion_documents(uri, document);
                let usage = slot_usage(&documents);
                let definitions = definitions(&documents);
                let vocabulary = self.vocabulary();
                for definition in &definitions {
                    if !definition.constant || vocabulary.contains_key(&definition.name) {
                        continue;
                    }
                    let sort = match usage.get(&definition.name) {
                        Some(used) if *used == kind => "0",
                        Some(_) => continue,
                        None => "1",
                    };
                    items.push(constant_item(definition, sort));
                }
                if !desktop_names_content(params, kind) {
                    let identities = self.content_identities();
                    self.push_vocabulary(&mut items, |name, value| {
                        identities.is_none_or(|identities| identities.names(kind, name, value))
                    });
                }
                defaults = Some(json!({
                    "data": { "rmsContent": match kind {
                        ContentKind::Object => "object",
                        ContentKind::Terrain => "terrain",
                    } }
                }));
            }
            (None, StrictArgumentKind::Condition) => {
                let documents = self.completion_documents(uri, document);
                let current = self.run_setting_labels();
                for definition in definitions(&documents) {
                    if current.contains_key(&definition.name) {
                        continue;
                    }
                    let detail = if definition.constant {
                        "#const"
                    } else {
                        "#define"
                    };
                    items.push(item(
                        &definition.name,
                        KIND_CONSTANT,
                        Some(definition_detail(detail, &definition)),
                        "0",
                    ));
                }
                let known = items
                    .iter()
                    .filter_map(|item| item["label"].as_str().map(str::to_owned))
                    .collect::<BTreeSet<_>>();
                for label in current.keys().filter(|label| !known.contains(*label)) {
                    items.push(item(
                        label,
                        KIND_CONSTANT,
                        Some("defined by the current run settings".to_owned()),
                        "1",
                    ));
                }
                for label in LOBBY_LABELS
                    .iter()
                    .filter(|label| !known.contains(**label) && !current.contains_key(**label))
                {
                    items.push(item(
                        label,
                        KIND_CONSTANT,
                        Some("defined by other run settings".to_owned()),
                        "2",
                    ));
                }
            }
            (None, StrictArgumentKind::Label) if head.name == "#undefine" => {
                let documents = self.completion_documents(uri, document);
                for definition in definitions(&documents) {
                    let detail = if definition.constant {
                        "#const"
                    } else {
                        "#define"
                    };
                    items.push(item(
                        &definition.name,
                        KIND_CONSTANT,
                        Some(definition_detail(detail, &definition)),
                        "0",
                    ));
                }
            }
            (None, StrictArgumentKind::Token) if head.name == "cliff_type" => {
                let cliff_types = self.cliff_types();
                for (position, name) in cliff_types.iter().enumerate() {
                    items.push(item(
                        name,
                        KIND_CONSTANT,
                        Some("cliff type".to_owned()),
                        &format!("0{position:03}"),
                    ));
                }
                let documents = self.completion_documents(uri, document);
                for definition in definitions(&documents)
                    .iter()
                    .filter(|definition| definition.constant)
                    .filter(|definition| !cliff_types.contains(&definition.name.as_str()))
                {
                    items.push(constant_item(definition, "1"));
                }
            }
            (None, StrictArgumentKind::Token) => {
                let documents = self.completion_documents(uri, document);
                let definitions = definitions(&documents);
                let vocabulary = self.vocabulary();
                for definition in definitions
                    .iter()
                    .filter(|definition| definition.constant)
                    .filter(|definition| !vocabulary.contains_key(&definition.name))
                {
                    items.push(constant_item(definition, "0"));
                }
                let wanted = named_slot_kind(head.name, index);
                let identities = self.content_identities();
                self.push_vocabulary(&mut items, |name, _| {
                    let found = identities.and_then(|identities| identities.kind_of(name));
                    wanted
                        .zip(found)
                        .is_none_or(|(wanted, found)| wanted == found)
                });
            }
            (None, StrictArgumentKind::Number | StrictArgumentKind::TolerantNumber) => {
                if !space {
                    let documents = self.completion_documents(uri, document);
                    let vocabulary = self.vocabulary();
                    for definition in definitions(&documents)
                        .iter()
                        .filter(|definition| definition.constant)
                        .filter(|definition| !vocabulary.contains_key(&definition.name))
                    {
                        items.push(constant_item(definition, "0"));
                    }
                    if let (Some(wanted), Some(identities)) =
                        (named_slot_kind(head.name, index), self.content_identities())
                    {
                        self.push_vocabulary(&mut items, |name, _| {
                            identities.kind_of(name) == Some(wanted)
                        });
                    }
                }
            }
            (None, StrictArgumentKind::Path) => {
                let typed = TypedPath::new(&word, &document.source.bytes()[offset.0 as usize..]);
                let range = |length: usize| {
                    let start = ByteOffset(offset.0.saturating_sub(length as u32));
                    crate::lsp_range(
                        &document.source,
                        rms_source::ByteRange { start, end: offset },
                    )
                    .unwrap_or(Value::Null)
                };
                let ranges = PathRanges {
                    path: range(typed.path_length()),
                    name: range(typed.name.len()),
                };
                let mut whole = Vec::new();
                if head.name == "#include_drs" {
                    whole.push(item("random_map.def", KIND_FILE, None, "0"));
                } else if head.name == "#include" {
                    let levels = self.include_levels(uri, document, &typed, &ranges);
                    items.extend(levels.items);
                    let profile = self.editor_selection().map(|catalog| catalog.profile_id());
                    for name in standard_include_names(profile) {
                        if levels.written.contains(&name.to_ascii_lowercase()) {
                            continue;
                        }
                        whole.push(item(
                            &name,
                            KIND_FILE,
                            Some("standard include".to_owned()),
                            "1",
                        ));
                    }
                }
                for mut value in whole {
                    let name = value["label"].as_str().unwrap_or_default().to_owned();
                    value["textEdit"] =
                        json!({ "range": ranges.path, "newText": typed.file_text(&name) });
                    items.push(value);
                }
            }
            (None, StrictArgumentKind::Label) => {}
        }
        let mut list = json!({ "isIncomplete": false, "items": items });
        if let Some(defaults) = defaults {
            list["itemDefaults"] = defaults;
        }
        Ok(list)
    }

    fn push_vocabulary(&self, items: &mut Vec<Value>, accepts: impl Fn(&str, &str) -> bool) {
        let listed = items
            .iter()
            .filter_map(|item| item["label"].as_str().map(str::to_owned))
            .collect::<BTreeSet<_>>();
        for (name, value) in self.vocabulary() {
            if listed.contains(name) || !accepts(name, value) {
                continue;
            }
            items.push(item(
                name,
                KIND_CONSTANT,
                Some(format!("= {value} · game definition")),
                "2",
            ));
        }
    }

    fn include_levels(
        &self,
        uri: &str,
        document: &OpenDocument,
        typed: &TypedPath,
        ranges: &PathRanges,
    ) -> IncludeLevel {
        let mut level = IncludeLevel::default();
        let Some(catalog) = self.editor_sources() else {
            return level;
        };
        let roots = &catalog.roots().opened_or_configured;
        let case_sensitive = catalog.case_sensitive();
        let Some(current) = catalog.sources().iter().find(|source| {
            source.role != SourceCatalogRole::ExternalXs && source.source_id.as_str() == uri
        }) else {
            return level;
        };
        if roots.is_empty() || !typed.followable {
            return level;
        }
        let Ok((resolver, current_path)) = self.rms_include_resolver(uri) else {
            return level;
        };
        let included = self
            .resolve_includes(uri, include_syntax(document))
            .into_iter()
            .filter_map(|link| link.target.ok())
            .collect::<BTreeSet<_>>();
        let key = |name: &str| {
            if case_sensitive {
                name.to_owned()
            } else {
                name.to_ascii_lowercase()
            }
        };
        let mut bases = Vec::new();
        for base in virtual_folder(&current_path)
            .into_iter()
            .chain(roots.iter().map(String::as_str))
        {
            if !bases.iter().any(|known: &&str| key(known) == key(base)) {
                bases.push(base);
            }
        }
        let files = catalog
            .sources()
            .iter()
            .filter(|source| {
                let id = source.source_id.as_str();
                source.role != SourceCatalogRole::ExternalXs
                    && matches!(
                        source.origin,
                        SourceCatalogOrigin::Workspace | SourceCatalogOrigin::DirtyBuffer
                    )
                    && id != current.source_id.as_str()
                    && !included.contains(id)
                    && roots
                        .iter()
                        .any(|root| relative_to(&source.path, root, case_sensitive).is_some())
            })
            .collect::<Vec<_>>();
        let mut entries = BTreeMap::<(bool, String), (String, Vec<(&str, &str, &str)>)>::new();
        for base in &bases {
            let Some(folder) = browse(base, &typed.segments) else {
                continue;
            };
            if typed.dotted
                && !roots
                    .iter()
                    .any(|root| within(&folder, root, case_sensitive))
            {
                continue;
            }
            for source in &files {
                let Some(below) = relative_to(&source.path, &folder, case_sensitive) else {
                    continue;
                };
                let (file, name) = match below.split_once('/') {
                    Some((name, _)) => (false, name),
                    None => (true, below),
                };
                entries
                    .entry((file, key(name)))
                    .or_insert_with(|| (name.to_owned(), Vec::new()))
                    .1
                    .push((source.source_id.as_str(), source.path.as_str(), below));
            }
        }
        let mut checks = 0_usize;
        let mut resolves_alone = |written: &str, id: &str| {
            if checks >= MAXIMUM_INCLUDE_FILES {
                return false;
            }
            checks += 1;
            IncludePath::new(written)
                .ok()
                .and_then(|include| resolver.resolve(&current_path, &include, &[]).ok())
                .is_some_and(|resolved| {
                    resolved.shadowed_candidates.is_empty()
                        && resolved.selected.source.id().as_str() == id
                })
        };
        for ((file, sort), (name, mut candidates)) in entries {
            if level.items.len() >= MAXIMUM_INCLUDE_FILES {
                break;
            }
            candidates.sort_by(|left, right| left.1.cmp(right.1));
            let written = candidates.iter().find_map(|(id, path, below)| {
                if typed.dotted {
                    bases.iter().find_map(|base| {
                        let relative = relative_to(path, base, case_sensitive)?;
                        resolves_alone(relative, id).then(|| relative.to_owned())
                    })
                } else {
                    let relative = format!("{}{below}", typed.folder);
                    resolves_alone(&relative, id).then_some(relative)
                }
            });
            let Some(written) = written else {
                continue;
            };
            let mut value = if file {
                level.written.insert(written.to_ascii_lowercase());
                typed.file_item(&name, &written, ranges)
            } else {
                typed.folder_item(&name, ranges)
            };
            value["sortText"] = json!(format!("0{}{sort}", u8::from(file)));
            level.items.push(value);
        }
        level
    }

    pub(crate) fn rms_signature_help(&self, params: &Value) -> RequestResult<Value> {
        let (uri, position) = request_position(params)?;
        let document = self.document(uri)?;
        let offset = byte_offset(&document.source, position)?;
        let context = caret_context(&document.source, &document.analysis.cst.tokens, offset);
        Ok(crate::rms_docs::signature_help(
            self, document, offset, &context,
        ))
    }
}

fn definition_detail(directive: &str, definition: &Definition) -> String {
    let mut detail = directive.to_owned();
    if let Some(value) = &definition.value {
        detail.push(' ');
        detail.push_str(value);
    }
    detail.push_str(if definition.here {
        " · this file"
    } else {
        " · included"
    });
    detail
}

fn constant_item(definition: &Definition, sort: &str) -> Value {
    item(
        &definition.name,
        KIND_CONSTANT,
        Some(definition_detail("#const", definition)),
        sort,
    )
}
