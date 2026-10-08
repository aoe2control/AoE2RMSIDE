use std::collections::BTreeMap;

use rms_semantics::{ArgumentResolution, StrictArgumentKind, StrictCommandKind, strict_command};
use rms_source::ByteRange;
use rms_syntax::{CstKind, Token, TokenKind};

use crate::lint::{
    Document, LintEnvironment, LintFinding, LintRelated, LintSeverity, MAXIMUM_LINT_RELATED,
    POSSIBLY_UNDEFINED_NAME, Predefined, ProgramView, literal_value,
};

pub(crate) const MAXIMUM_WORLDS: usize = 64;

const MAXIMUM_DEPTH: usize = 63;

enum Item {
    Define { name: usize, certain: bool },
    Use(usize),
    If(Conditional),
    Random(RandomBlock),
}

struct Conditional {
    branches: Vec<(Condition, Vec<Item>)>,
    defines: Bits,
}

enum Condition {
    Word(String),
    Else,
    Never,
}

struct RandomBlock {
    weights: Vec<Option<i32>>,
    branches: Vec<Vec<Item>>,
    has_prefix: bool,
    defines: Bits,
}

struct UseSite {
    name: usize,
    range: ByteRange,
    command: String,
    reads_a_name: bool,
    quiet: bool,
    defined: bool,
    maybe: bool,
    undefined: bool,
}

#[derive(Clone, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct Bits(Vec<u64>);

impl Bits {
    fn with_capacity(names: usize) -> Self {
        Self(vec![0; names.div_ceil(64)])
    }
    fn set(&mut self, index: usize) {
        self.0[index / 64] |= 1 << (index % 64);
    }
    fn get(&self, index: usize) -> bool {
        self.0[index / 64] & (1 << (index % 64)) != 0
    }
    fn union(&mut self, other: &Self) {
        for (word, other) in self.0.iter_mut().zip(&other.0) {
            *word |= other;
        }
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct World {
    defined: Bits,
    maybe: Bits,
    marks: u64,
}

impl World {
    fn settle(&mut self, defines: &Bits) {
        for ((maybe, defined), defines) in
            self.maybe.0.iter_mut().zip(&self.defined.0).zip(&defines.0)
        {
            *maybe |= defines & !defined;
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Truth {
    True,
    False,
    Unknown,
}

struct Builder<'d, 'a> {
    document: &'d Document<'a>,
    predefined: &'d dyn Fn(&str) -> Predefined,
    tracked: BTreeMap<String, usize>,
    uses: Vec<UseSite>,
    definitions: Vec<Vec<ByteRange>>,
}

enum Frame {
    If(Vec<(Condition, Vec<Item>)>, bool),
    Random {
        prefix: Vec<Item>,
        branches: Vec<(Option<i32>, Vec<Item>)>,
    },
}

impl Frame {
    fn items(&mut self) -> &mut Vec<Item> {
        match self {
            Frame::If(branches, _) => &mut branches.last_mut().expect("a branch").1,
            Frame::Random { prefix, branches } => match branches.last_mut() {
                Some(branch) => &mut branch.1,
                None => prefix,
            },
        }
    }
}

impl<'d, 'a> Builder<'d, 'a> {
    fn build(&mut self) -> Option<Vec<Item>> {
        let analysis = self.document.analysis;
        let tokens = &analysis.cst.tokens;
        let mut root = Vec::new();
        let mut stack = Vec::<Frame>::new();
        for node in &analysis.cst.nodes {
            let words = tokens[node.token_start as usize..node.token_end as usize]
                .iter()
                .filter(|token| !token.kind.is_trivia())
                .collect::<Vec<_>>();
            let Some(head) = words.first() else {
                continue;
            };
            let head_text = self.document.text(head);
            let uncertain = self.uncertain(node.range);
            match node.kind {
                CstKind::Conditional | CstKind::RandomBranch => {
                    if uncertain || stack.len() > MAXIMUM_DEPTH {
                        return None;
                    }
                    let open_if = stack.iter().any(|frame| matches!(frame, Frame::If(..)));
                    let open_random = stack
                        .iter()
                        .any(|frame| matches!(frame, Frame::Random { .. }));
                    match head_text {
                        "if" => stack.push(Frame::If(
                            vec![(Condition::Word(condition(self, &words)?), Vec::new())],
                            false,
                        )),
                        "elseif" | "else" if !open_if => {}
                        "elseif" => {
                            let word = condition(self, &words)?;
                            let Some(Frame::If(branches, has_else)) = stack.last_mut() else {
                                return None;
                            };
                            let condition = if *has_else {
                                Condition::Never
                            } else {
                                Condition::Word(word)
                            };
                            branches.push((condition, Vec::new()));
                        }
                        "else" => {
                            let Some(Frame::If(branches, has_else)) = stack.last_mut() else {
                                return None;
                            };
                            if words.len() != 1 {
                                return None;
                            }
                            let condition = if *has_else {
                                Condition::Never
                            } else {
                                Condition::Else
                            };
                            branches.push((condition, Vec::new()));
                            *has_else = true;
                        }
                        "endif" if !open_if => {}
                        "endif" => {
                            if words.len() != 1 {
                                return None;
                            }
                            let Some(Frame::If(branches, _)) = stack.pop() else {
                                return None;
                            };
                            let mut defines = Bits::with_capacity(self.tracked.len());
                            for (_, items) in &branches {
                                collect_defines(items, &mut defines);
                            }
                            let item = Item::If(Conditional { branches, defines });
                            current(&mut stack, &mut root).push(item);
                        }
                        "start_random" if words.len() == 1 => stack.push(Frame::Random {
                            prefix: Vec::new(),
                            branches: Vec::new(),
                        }),
                        "percent_chance" | "end_random" if !open_random => {}
                        "percent_chance" => match stack.last_mut() {
                            Some(Frame::Random { branches, .. }) if words.len() == 2 => {
                                let weight = literal_value(self.document, words[1])
                                    .filter(|value| {
                                        *value >= i32::MIN as f32 && *value <= i32::MAX as f32
                                    })
                                    .map(|value| value.round() as i32);
                                branches.push((weight, Vec::new()));
                            }
                            _ => return None,
                        },
                        "end_random" => {
                            if words.len() != 1 {
                                return None;
                            }
                            let Some(Frame::Random { prefix, branches }) = stack.pop() else {
                                return None;
                            };
                            let mut prefix_items = Vec::with_capacity(prefix.len());
                            for item in prefix {
                                match item {
                                    Item::Define { name, .. } => prefix_items.push(Item::Define {
                                        name,
                                        certain: false,
                                    }),
                                    Item::Use(site) => self.uses[site].quiet = true,
                                    Item::If(_) | Item::Random(_) => return None,
                                }
                            }
                            let mut defines = Bits::with_capacity(self.tracked.len());
                            let (weights, branches): (Vec<_>, Vec<_>) =
                                branches.into_iter().unzip();
                            for items in &branches {
                                collect_defines(items, &mut defines);
                            }
                            let block = RandomBlock {
                                weights,
                                branches,
                                has_prefix: !prefix_items.is_empty(),
                                defines,
                            };
                            let parent = current(&mut stack, &mut root);
                            parent.extend(prefix_items);
                            parent.push(Item::Random(block));
                        }
                        _ => return None,
                    }
                }
                CstKind::Definition => {
                    if !matches!(head_text, "#define" | "#const") {
                        continue;
                    }
                    let Some(name) = words
                        .get(1)
                        .filter(|word| word.kind == TokenKind::Identifier)
                    else {
                        continue;
                    };
                    if let Some(&index) = self.tracked.get(self.document.text(name)) {
                        let written = &mut self.definitions[index];
                        if written.len() < MAXIMUM_LINT_RELATED {
                            written.push(name.range);
                        }
                        current(&mut stack, &mut root).push(Item::Define {
                            name: index,
                            certain: !uncertain,
                        });
                    }
                }
                CstKind::Command | CstKind::Attribute | CstKind::Error => {
                    let command = strict_command(head_text);
                    if command.is_none()
                        && (self.document.defined_here.contains(head_text)
                            || (self.predefined)(head_text) != Predefined::Never)
                    {
                        return None;
                    }
                    let Some(command) =
                        command.filter(|command| command.kind == StrictCommandKind::Descriptor)
                    else {
                        continue;
                    };
                    for (kind, word) in command.arguments.iter().zip(&words[1..]) {
                        if !self.whole_word(word) {
                            break;
                        }
                        let reads_a_name = match kind {
                            StrictArgumentKind::Token => true,
                            StrictArgumentKind::Number | StrictArgumentKind::TolerantNumber => {
                                false
                            }
                            _ => break,
                        };
                        if word.kind != TokenKind::Identifier {
                            continue;
                        }
                        let Some(&name) = self.tracked.get(self.document.text(word)) else {
                            continue;
                        };
                        let site = self.uses.len();
                        self.uses.push(UseSite {
                            name,
                            range: word.range,
                            command: head_text.to_owned(),
                            reads_a_name,
                            quiet: uncertain,
                            defined: false,
                            maybe: false,
                            undefined: false,
                        });
                        current(&mut stack, &mut root).push(Item::Use(site));
                    }
                }
                CstKind::Section | CstKind::Include | CstKind::Brace => {}
            }
        }
        stack.is_empty().then_some(root)
    }

    fn uncertain(&self, range: ByteRange) -> bool {
        let lines = &self.document.lines;
        let index = lines.partition_point(|line| line.full.end <= range.start);
        lines
            .get(index)
            .is_none_or(|line| line.uncertain || line.full.start > range.start)
    }

    fn whole_word(&self, token: &Token) -> bool {
        let bytes = self.document.source.bytes();
        let start = token.range.start.0 as usize;
        let end = token.range.end.0 as usize;
        let apart = |byte: Option<&u8>| byte.is_none_or(u8::is_ascii_whitespace);
        bytes[start..end]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
            && apart(start.checked_sub(1).and_then(|before| bytes.get(before)))
            && apart(bytes.get(end))
    }
}

fn condition(builder: &Builder<'_, '_>, words: &[&Token]) -> Option<String> {
    match words {
        [_, word] if matches!(word.kind, TokenKind::Identifier | TokenKind::Number) => {
            Some(builder.document.text(word).to_owned())
        }
        _ => None,
    }
}

fn current<'s>(stack: &'s mut [Frame], root: &'s mut Vec<Item>) -> &'s mut Vec<Item> {
    match stack.last_mut() {
        Some(frame) => frame.items(),
        None => root,
    }
}

fn collect_defines(items: &[Item], defines: &mut Bits) {
    for item in items {
        match item {
            Item::Define { name, .. } => defines.set(*name),
            Item::If(conditional) => defines.union(&conditional.defines),
            Item::Random(block) => defines.union(&block.defines),
            Item::Use(_) => {}
        }
    }
}

fn reachable_branches(weights: &[Option<i32>]) -> Option<(Vec<bool>, bool)> {
    let weights = weights.iter().copied().collect::<Option<Vec<_>>>()?;
    let mut chosen = vec![false; weights.len()];
    let mut none = false;
    for roll in 0..100_i32 {
        let mut remaining = roll;
        let mut selected = None;
        for (position, weight) in weights.iter().enumerate() {
            if remaining <= *weight {
                selected = Some(position);
                break;
            }
            remaining = remaining.saturating_sub(*weight);
        }
        match selected {
            Some(position) => chosen[position] = true,
            None => none = true,
        }
    }
    Some((chosen, none))
}

struct Interpreter<'d> {
    predefined: &'d dyn Fn(&str) -> Predefined,
    tracked: &'d BTreeMap<String, usize>,
    uses: &'d mut [UseSite],
    names: usize,
    quiet: usize,
}

impl Interpreter<'_> {
    fn truth(&self, world: &World, name: &str) -> Truth {
        match (self.predefined)(name) {
            Predefined::Always => Truth::True,
            Predefined::Maybe => Truth::Unknown,
            Predefined::Never => match self.tracked.get(name) {
                Some(&index) if world.defined.get(index) => Truth::True,
                Some(&index) if world.maybe.get(index) => Truth::Unknown,
                _ => Truth::False,
            },
        }
    }

    fn run(&mut self, items: &[Item], mut worlds: Vec<World>, depth: usize) -> Vec<World> {
        for item in items {
            if worlds.is_empty() {
                break;
            }
            match item {
                Item::Define { name, certain } => {
                    for world in &mut worlds {
                        if *certain {
                            world.defined.set(*name);
                        } else if !world.defined.get(*name) {
                            world.maybe.set(*name);
                        }
                    }
                }
                Item::Use(site) => {
                    let site = &mut self.uses[*site];
                    if self.quiet > 0 {
                        site.quiet = true;
                        continue;
                    }
                    for world in &worlds {
                        if world.defined.get(site.name) {
                            site.defined = true;
                        } else if world.maybe.get(site.name) {
                            site.maybe = true;
                        } else {
                            site.undefined = true;
                        }
                    }
                }
                Item::If(conditional) => {
                    let mark = 1_u64 << depth;
                    let mut groups = vec![Vec::new(); conditional.branches.len() + 1];
                    for world in worlds {
                        let mut targets = Vec::new();
                        let mut decided = false;
                        let mut undecided = false;
                        for (index, (condition, _)) in conditional.branches.iter().enumerate() {
                            let truth = match condition {
                                Condition::Word(name) => self.truth(&world, name),
                                Condition::Else => Truth::True,
                                Condition::Never => Truth::False,
                            };
                            match truth {
                                Truth::True => {
                                    targets.push(index);
                                    decided = true;
                                    break;
                                }
                                Truth::False => {}
                                Truth::Unknown => {
                                    targets.push(index);
                                    undecided = true;
                                }
                            }
                        }
                        if !decided {
                            targets.push(conditional.branches.len());
                        }
                        let mut world = world;
                        if undecided {
                            world.marks |= mark;
                        }
                        for target in targets {
                            groups[target].push(world.clone());
                        }
                    }
                    let skipped = groups.pop().unwrap_or_default();
                    let mut next = skipped;
                    for ((_, items), group) in conditional.branches.iter().zip(groups) {
                        if !group.is_empty() {
                            next.extend(self.run(items, group, depth + 1));
                        }
                    }
                    for world in &mut next {
                        if world.marks & mark != 0 {
                            world.settle(&conditional.defines);
                            world.marks &= !mark;
                        }
                    }
                    worlds = self.bound(next);
                }
                Item::Random(block) => {
                    let mark = 1_u64 << depth;
                    let certain = (!block.has_prefix)
                        .then(|| reachable_branches(&block.weights))
                        .flatten();
                    let (chosen, none) = match &certain {
                        Some((chosen, none)) => (chosen.clone(), *none),
                        None => (vec![true; block.branches.len()], true),
                    };
                    if certain.is_none() {
                        for world in &mut worlds {
                            world.marks |= mark;
                        }
                        self.quiet += 1;
                    }
                    let mut next = Vec::new();
                    for (items, chosen) in block.branches.iter().zip(&chosen) {
                        if *chosen {
                            next.extend(self.run(items, worlds.clone(), depth + 1));
                        }
                    }
                    if none {
                        next.extend(worlds);
                    }
                    if certain.is_none() {
                        self.quiet -= 1;
                    }
                    for world in &mut next {
                        if world.marks & mark != 0 {
                            world.settle(&block.defines);
                            world.marks &= !mark;
                        }
                    }
                    worlds = self.bound(next);
                }
            }
        }
        worlds
    }

    fn bound(&self, mut worlds: Vec<World>) -> Vec<World> {
        worlds.sort();
        worlds.dedup();
        if worlds.len() <= MAXIMUM_WORLDS {
            return worlds;
        }
        let mut all = worlds[0].defined.clone();
        let mut any = Bits::with_capacity(self.names);
        let mut maybe = Bits::with_capacity(self.names);
        let mut marks = 0;
        for world in &worlds {
            for (all, defined) in all.0.iter_mut().zip(&world.defined.0) {
                *all &= defined;
            }
            any.union(&world.defined);
            maybe.union(&world.maybe);
            marks |= world.marks;
        }
        for ((maybe, any), all) in maybe.0.iter_mut().zip(&any.0).zip(&all.0) {
            *maybe |= any & !all;
        }
        vec![World {
            defined: all,
            maybe,
            marks,
        }]
    }
}

fn strict_reports(document: &Document<'_>, view: &ProgramView<'_>) -> Vec<ByteRange> {
    let id = document.source.id();
    let mut ranges = Vec::new();
    for decision in &view.program.decisions {
        if decision.source_id == *id
            && decision.kind == rms_semantics::ParsedDecisionKind::UndefinedNumericFallback
        {
            ranges.push(decision.source_range);
        }
    }
    for operation in &view.program.operations {
        if operation.source_id == *id
            && operation.arguments.iter().any(|argument| {
                matches!(
                    argument.resolution,
                    ArgumentResolution::UnregisteredNumber
                        | ArgumentResolution::UndefinedNumericFallback
                )
            })
        {
            ranges.push(operation.source_range);
        }
    }
    ranges
}

pub(crate) fn possibly_undefined_names(
    document: &Document<'_>,
    environment: &LintEnvironment<'_>,
    findings: &mut Vec<LintFinding>,
) {
    let Some(predefined) = environment.predefined else {
        return;
    };
    if !environment.is_entry_script {
        return;
    }
    let tracked = document
        .defined_here
        .iter()
        .filter(|name| predefined(name) == Predefined::Never)
        .enumerate()
        .map(|(index, name)| (name.clone(), index))
        .collect::<BTreeMap<_, _>>();
    if tracked.is_empty() {
        return;
    }
    let definitions = vec![Vec::new(); tracked.len()];
    let mut builder = Builder {
        document,
        predefined,
        tracked,
        uses: Vec::new(),
        definitions,
    };
    let Some(items) = builder.build() else {
        return;
    };
    if builder.uses.is_empty() {
        return;
    }
    let names = builder.tracked.len();
    let start = World {
        defined: Bits::with_capacity(names),
        maybe: Bits::with_capacity(names),
        marks: 0,
    };
    let mut interpreter = Interpreter {
        predefined,
        tracked: &builder.tracked,
        uses: &mut builder.uses,
        names,
        quiet: 0,
    };
    interpreter.run(&items, vec![start], 0);
    let reported = environment
        .program
        .as_ref()
        .map(|view| strict_reports(document, view))
        .unwrap_or_default();
    let name_of = builder
        .tracked
        .iter()
        .map(|(name, index)| (*index, name.as_str()))
        .collect::<BTreeMap<_, _>>();
    for site in &builder.uses {
        if site.quiet || !site.undefined {
            continue;
        }
        if reported
            .iter()
            .any(|range| range.start <= site.range.start && site.range.end <= range.end)
        {
            continue;
        }
        let name = name_of[&site.name];
        let command = &site.command;
        let consequence = if site.reads_a_name {
            format!("the game ignores this {command}")
        } else {
            format!("{command} reads it as 0")
        };
        let message = if site.defined || site.maybe {
            format!(
                "{name} may be undefined here: on some random or conditional paths to this line no #define or #const of it has run, and there {consequence}."
            )
        } else {
            format!(
                "{name} is undefined on every path to this line: the script defines it only elsewhere or later, so {consequence}."
            )
        };
        let related = builder.definitions[site.name]
            .iter()
            .map(|range| LintRelated {
                source_id: None,
                range: *range,
                message: format!("{name} is defined here"),
            })
            .collect();
        findings.push(LintFinding {
            related,
            code: POSSIBLY_UNDEFINED_NAME,
            severity: LintSeverity::Hint,
            message,
            range: site.range,
            unnecessary: false,
            fix: None,
        });
    }
}
