use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use rms_source::{ByteRange, SourceId};
use xs_analysis::{DefaultValue, Ty};
use xs_syntax::{
    AssignOp, BinaryOp, Block, CompareOp, Expr, ExprKind, Literal, Modifiers, Name,
    RuleModifierKind, Stmt, StmtKind, TypeName, TypeRef, UnaryOp, VarDecl,
};

use crate::program::{ItemRef, Program};
use crate::random::XsRandom;
use crate::table::{CallClass, UnansweredReason, call_table};
use crate::text::number_text;
use crate::value::{Object, Value, ValueKind, float_to_int, zero_value};
use crate::{
    DEFAULT_CALL_DEPTH, DEFAULT_STEP_LIMIT, HostAnswer, HostCall, HostNote, MAXIMUM_ARRAY_ITEMS,
    MAXIMUM_FINDINGS, MAXIMUM_TEXT_BYTES, MAXIMUM_TEXT_TOTAL_BYTES, RUN_STACK_BYTES, Unanswered,
    XsHost,
};

const CANCEL_CHECK_INTERVAL: u64 = 65_536;
const MAXIMUM_CLASS_NESTING: u32 = 16;

#[derive(Clone, Copy)]
pub struct RunOptions<'a> {
    pub step_limit: u64,
    pub map_seed: i64,
    pub cancelled: Option<&'a (dyn Fn() -> bool + Sync)>,
}

impl std::fmt::Debug for RunOptions<'_> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RunOptions")
            .field("step_limit", &self.step_limit)
            .field("map_seed", &self.map_seed)
            .field("cancellable", &self.cancelled.is_some())
            .finish()
    }
}

impl Default for RunOptions<'_> {
    fn default() -> Self {
        Self {
            step_limit: DEFAULT_STEP_LIMIT,
            map_seed: 0,
            cancelled: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Topic {
    IntegerArithmetic,
    MixedNumbers,
    NumberText,
    TextFunctions,
    ArrayDefaults,
    RuleOrder,
    Goto,
    StartDefaults,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FindingSeverity {
    Error,
    Warning,
    Information,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Finding {
    pub code: &'static str,
    pub severity: FindingSeverity,
    pub message: String,
    pub arguments: Vec<(&'static str, String)>,
    pub source_id: Option<SourceId>,
    pub range: Option<ByteRange>,
    pub count: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StopCode {
    StepLimit,
    CallDepth,
    DivisionByZero,
    RemainderByZero,
    MemoryBound,
    Unanswered,
    NotRun,
}

impl StopCode {
    pub const fn code(self) -> &'static str {
        match self {
            Self::StepLimit => "XS5001",
            Self::CallDepth => "XS5002",
            Self::DivisionByZero => "XS5005",
            Self::RemainderByZero => "XS5006",
            Self::MemoryBound => "XS5008",
            Self::Unanswered => "XS5010",
            Self::NotRun => "XS5013",
        }
    }

    pub const fn severity(self) -> FindingSeverity {
        match self {
            Self::Unanswered => FindingSeverity::Information,
            _ => FindingSeverity::Error,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stop {
    pub code: StopCode,
    pub message: String,
    pub arguments: Vec<(&'static str, String)>,
    pub source_id: Option<SourceId>,
    pub range: Option<ByteRange>,
    pub function: Option<String>,
    pub in_rule: bool,
    pub call: Option<String>,
    pub reason: Option<Unanswered>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum RunStatus {
    Completed,
    Stopped(Stop),
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunReport {
    pub status: RunStatus,
    pub main_ran: bool,
    pub rules_run: u32,
    pub steps: u64,
    pub step_limit: u64,
    pub findings: Vec<Finding>,
    pub omitted_findings: u32,
    pub topics: BTreeSet<Topic>,
    pub random_draws: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum CallOutcome {
    Returned(Value),
    Stopped(Stop),
    NoSuchFunction,
}

pub(crate) enum Halt {
    Stop(Box<Stop>),
    Cancelled,
}

pub(crate) type Exec<T> = Result<T, Halt>;

enum Flow<'p> {
    Normal,
    Break,
    Continue,
    Return(Value),
    Goto(&'p str),
}

#[derive(Clone, Copy)]
enum Place {
    Local(usize),
    Static((usize, u32)),
    Global(usize),
}

enum Binding {
    Value(Value),
    Static((usize, u32)),
}

struct Frame<'p> {
    vars: Vec<(&'p str, Binding)>,
    marks: Vec<usize>,
    name: &'p str,
    in_rule: bool,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct RuleState {
    pub enabled: bool,
    pub priority: i32,
    pub min_interval: i32,
    pub max_interval: i32,
}

pub(crate) struct ArrayData {
    pub kind: ValueKind,
    pub name: String,
    pub items: Vec<Value>,
}

#[derive(Default)]
pub(crate) struct Arrays {
    pub list: Vec<ArrayData>,
    pub items: usize,
}

pub(crate) struct Machine<'p> {
    pub program: &'p Program,
    host: &'p mut dyn XsHost,
    globals: Vec<Value>,
    global_index: HashMap<&'p str, usize>,
    frames: Vec<Frame<'p>>,
    statics: HashMap<(usize, u32), Value>,
    pub arrays: Arrays,
    pub rules: Vec<RuleState>,
    pub current_rule: Option<usize>,
    pub context_player: Option<i32>,
    steps: u64,
    step_limit: u64,
    next_cancel_check: u64,
    cancelled: Option<&'p (dyn Fn() -> bool + Sync)>,
    counting: bool,
    findings: Vec<Finding>,
    finding_index: HashMap<(&'static str, usize, u32, u32), usize>,
    omitted_findings: u32,
    pub topics: BTreeSet<Topic>,
    pub random: XsRandom,
    pub random_draws: u32,
    depth_limit: u32,
    text_total: usize,
    file: usize,
    main_ran: bool,
    rules_run: u32,
}

pub fn run_start(
    program: &Program,
    host: &mut dyn XsHost,
    options: &RunOptions<'_>,
) -> Option<RunReport> {
    on_run_stack(|| {
        let mut machine = Machine::new(program, host, options);
        let result = machine.start();
        machine.finish(result)
    })
}

pub fn call_function(
    program: &Program,
    name: &str,
    args: &[Value],
    host: &mut dyn XsHost,
    options: &RunOptions<'_>,
) -> Option<(CallOutcome, RunReport)> {
    let Some(at) = program.functions.get(name).copied() else {
        return Some((
            CallOutcome::NoSuchFunction,
            RunReport {
                status: RunStatus::Completed,
                main_ran: false,
                rules_run: 0,
                steps: 0,
                step_limit: options.step_limit,
                findings: Vec::new(),
                omitted_findings: 0,
                topics: BTreeSet::new(),
                random_draws: 0,
            },
        ));
    };
    on_run_stack(|| {
        let mut machine = Machine::new(program, host, options);
        let result = machine.init().and_then(|()| {
            let range = program.function(at).name.range;
            machine.call_user(at, args.to_vec(), range)
        });
        let outcome = match &result {
            Ok(value) => CallOutcome::Returned(value.clone()),
            Err(Halt::Stop(stop)) => CallOutcome::Stopped((**stop).clone()),
            Err(Halt::Cancelled) => return None,
        };
        let report = machine.finish(result.map(|_| ()))?;
        Some((outcome, report))
    })
}

fn on_run_stack<T: Send>(run: impl FnOnce() -> Option<T> + Send) -> Option<T> {
    std::thread::scope(|scope| {
        match std::thread::Builder::new()
            .name("xs-eval".to_owned())
            .stack_size(RUN_STACK_BYTES)
            .spawn_scoped(scope, run)
        {
            Ok(handle) => handle
                .join()
                .unwrap_or_else(|panic| std::panic::resume_unwind(panic)),
            Err(_) => None,
        }
    })
}

impl<'p> Machine<'p> {
    pub(crate) fn new(
        program: &'p Program,
        host: &'p mut dyn XsHost,
        options: &RunOptions<'p>,
    ) -> Self {
        let depth_limit = match program.recursion_limit {
            Some(limit) if limit >= 1 => (limit.min(i64::from(DEFAULT_CALL_DEPTH))) as u32,
            _ => DEFAULT_CALL_DEPTH,
        };
        Self {
            program,
            host,
            globals: Vec::new(),
            global_index: HashMap::new(),
            frames: Vec::new(),
            statics: HashMap::new(),
            arrays: Arrays::default(),
            rules: Vec::new(),
            current_rule: None,
            context_player: None,
            steps: 0,
            step_limit: options.step_limit,
            next_cancel_check: CANCEL_CHECK_INTERVAL,
            cancelled: options.cancelled,
            counting: true,
            findings: Vec::new(),
            finding_index: HashMap::new(),
            omitted_findings: 0,
            topics: BTreeSet::new(),
            random: XsRandom::new(options.map_seed),
            random_draws: 0,
            depth_limit,
            text_total: 0,
            file: 0,
            main_ran: false,
            rules_run: 0,
        }
    }

    fn finish(self, result: Exec<()>) -> Option<RunReport> {
        let status = match result {
            Ok(()) => RunStatus::Completed,
            Err(Halt::Stop(stop)) => RunStatus::Stopped(*stop),
            Err(Halt::Cancelled) => return None,
        };
        Some(RunReport {
            status,
            main_ran: self.main_ran,
            rules_run: self.rules_run,
            steps: self.steps,
            step_limit: self.step_limit,
            findings: self.findings,
            omitted_findings: self.omitted_findings,
            topics: self.topics,
            random_draws: self.random_draws,
        })
    }

    fn init(&mut self) -> Exec<()> {
        let program = self.program;
        let mut declared = Vec::new();
        for (file, variable) in program.global_variables() {
            let kind = self.kind_of(&variable.ty, variable.name.range)?;
            let value = self.default_of(kind, variable.name.range, 0)?;
            let slot = self.globals.len();
            self.globals.push(value);
            self.global_index.insert(variable.name.text.as_str(), slot);
            declared.push((file, variable, slot));
        }
        for (file, variable, slot) in declared {
            let Some(init) = &variable.init else {
                continue;
            };
            self.file = file;
            self.counting = file >= program.unit_start;
            let value = self.eval(init)?;
            let kind = self.globals[slot].kind();
            self.globals[slot] = self.convert(value, kind, init.range, false)?;
        }
        self.counting = true;
        for rule in &program.rules {
            let declaration = program.rule(rule.at);
            let mut state = RuleState {
                enabled: rule.active,
                priority: 0,
                min_interval: 0,
                max_interval: 0,
            };
            self.file = rule.at.file;
            for modifier in &declaration.modifiers {
                let Some(value) = &modifier.value else {
                    continue;
                };
                let number = match self.eval(value)? {
                    Value::Int(number) => number,
                    Value::Float(number) => float_to_int(number).0,
                    _ => 0,
                };
                match modifier.kind {
                    RuleModifierKind::Priority => state.priority = number,
                    RuleModifierKind::MinInterval => state.min_interval = number,
                    RuleModifierKind::MaxInterval => state.max_interval = number,
                    _ => {}
                }
            }
            self.rules.push(state);
        }
        Ok(())
    }

    fn start(&mut self) -> Exec<()> {
        self.init()?;
        if let Some(main) = self.program.functions.get("main").copied() {
            let range = self.program.function(main).name.range;
            self.main_ran = true;
            self.call_user(main, Vec::new(), range)?;
        }
        let mut pass = (0..self.rules.len())
            .filter(|index| self.rules[*index].enabled)
            .collect::<Vec<_>>();
        pass.sort_by(|left, right| {
            self.rules[*right]
                .priority
                .cmp(&self.rules[*left].priority)
                .then(left.cmp(right))
        });
        let mut ran = vec![false; self.rules.len()];
        for index in pass {
            if !self.rules[index].enabled {
                continue;
            }
            self.topics.insert(Topic::RuleOrder);
            ran[index] = true;
            self.rules_run += 1;
            self.run_rule(index)?;
        }
        for (index, rule) in self.program.rules.iter().enumerate() {
            if self.rules[index].enabled && !ran[index] {
                let at = self.program.rule(rule.at).name.range;
                self.file = rule.at.file;
                self.finding(
                    "XS5020",
                    FindingSeverity::Information,
                    format!(
                        "Rule {} is enabled for later; timed rules are not run",
                        rule.name
                    ),
                    vec![("rule", rule.name.clone())],
                    at,
                );
            }
        }
        Ok(())
    }

    fn run_rule(&mut self, index: usize) -> Exec<()> {
        let info = &self.program.rules[index];
        let rule = self.program.rule(info.at);
        let Some(body) = &rule.body else {
            return Ok(());
        };
        if self.frames.len() as u32 >= self.depth_limit {
            return Err(self.stop_depth(rule.name.range));
        }
        let previous_rule = self.current_rule.replace(index);
        let previous_file = self.file;
        self.frames.push(Frame {
            vars: Vec::new(),
            marks: Vec::new(),
            name: rule.name.text.as_str(),
            in_rule: true,
        });
        self.file = info.at.file;
        let flow = self.run_list(&body.stmts, None);
        self.frames.pop();
        self.file = previous_file;
        self.current_rule = previous_rule;
        match flow? {
            Flow::Goto(label) => Err(self.stop_goto(label, rule.name.range)),
            _ => Ok(()),
        }
    }

    pub(crate) fn call_user(
        &mut self,
        at: ItemRef,
        args: Vec<Value>,
        range: ByteRange,
    ) -> Exec<Value> {
        let program = self.program;
        let function = program.function(at);
        let Some(body) = &function.body else {
            return Err(self.stop_not_run(
                format!("function {} without a body", function.name.text),
                range,
            ));
        };
        if self.frames.len() as u32 >= self.depth_limit {
            return Err(self.stop_depth(range));
        }
        let return_kind = self.kind_of(&function.return_type, function.name.range)?;
        let previous_file = self.file;
        self.frames.push(Frame {
            vars: Vec::new(),
            marks: Vec::new(),
            name: function.name.text.as_str(),
            in_rule: false,
        });
        self.file = at.file;
        let result = self.bind_and_run(function, args, body, return_kind);
        self.frames.pop();
        self.file = previous_file;
        result
    }

    fn bind_and_run(
        &mut self,
        function: &'p xs_syntax::FunctionDecl,
        args: Vec<Value>,
        body: &'p Block,
        return_kind: ValueKind,
    ) -> Exec<Value> {
        let mut args = args.into_iter();
        for param in &function.params {
            let kind = self.kind_of(&param.ty, param.name.range)?;
            let value = match args.next() {
                Some(value) => self.convert(value, kind, param.range, true)?,
                None => match &param.default {
                    Some(default) => {
                        let value = self.eval(default)?;
                        self.convert(value, kind, default.range, false)?
                    }
                    None => self.default_of(kind, param.range, 0)?,
                },
            };
            self.frame_mut()
                .vars
                .push((param.name.text.as_str(), Binding::Value(value)));
        }
        let flow = self.run_list(&body.stmts, None)?;
        match flow {
            Flow::Return(value) if return_kind != ValueKind::Void => {
                let range = function.name.range;
                self.convert(value, return_kind, range, true)
            }
            Flow::Goto(label) => Err(self.stop_goto(label, function.name.range)),
            _ => self.default_of(return_kind, function.name.range, 0),
        }
    }

    fn run_list(&mut self, stmts: &'p [Stmt], resume: Option<&'p str>) -> Exec<Flow<'p>> {
        let mut index = 0;
        let mut pending = resume;
        loop {
            if let Some(label) = pending.take() {
                match self.find_label(stmts, label)? {
                    Some((found, true)) => index = found + 1,
                    Some((found, false)) => match self.resume_stmt(&stmts[found], label)? {
                        Flow::Normal => index = found + 1,
                        Flow::Goto(next) => {
                            pending = Some(next);
                            continue;
                        }
                        other => return Ok(other),
                    },
                    None => return Ok(Flow::Goto(label)),
                }
            }
            let Some(stmt) = stmts.get(index) else {
                return Ok(Flow::Normal);
            };
            match self.exec_stmt(stmt)? {
                Flow::Normal => index += 1,
                Flow::Goto(label) => pending = Some(label),
                other => return Ok(other),
            }
        }
    }

    fn exec_scoped(&mut self, stmt: &'p Stmt) -> Exec<Flow<'p>> {
        self.push_scope();
        let flow = self.exec_stmt(stmt);
        self.pop_scope();
        flow
    }

    fn exec_stmt(&mut self, stmt: &'p Stmt) -> Exec<Flow<'p>> {
        self.step(stmt.range)?;
        match &stmt.kind {
            StmtKind::Block(block) => {
                self.push_scope();
                let flow = self.run_list(&block.stmts, None);
                self.pop_scope();
                flow
            }
            StmtKind::Variable(variable) => {
                self.declare_local(variable)?;
                Ok(Flow::Normal)
            }
            StmtKind::Assign { target, op, value } => {
                self.assign(target, *op, value.as_ref(), stmt.range)?;
                Ok(Flow::Normal)
            }
            StmtKind::Expr(expr) => {
                self.eval(expr)?;
                Ok(Flow::Normal)
            }
            StmtKind::If {
                condition,
                then_branch,
                else_branch,
            } => {
                let condition = self.condition(condition.as_ref(), stmt.range)?;
                let branch = if condition { then_branch } else { else_branch };
                match branch {
                    Some(branch) => self.exec_scoped(branch),
                    None => Ok(Flow::Normal),
                }
            }
            StmtKind::While { condition, body } => {
                self.run_while(condition.as_ref(), body.as_deref(), stmt.range)
            }
            StmtKind::For {
                variable,
                start,
                compare,
                limit,
                body,
            } => {
                let (Some(variable), Some(start), Some(compare), Some(limit)) =
                    (variable, start, compare, limit)
                else {
                    return Err(self.stop_not_run("an incomplete for loop".to_owned(), stmt.range));
                };
                let place = self.for_variable(variable)?;
                let value = self.eval(start)?;
                let kind = self.read(place).kind();
                let value = self.convert(value, kind, start.range, false)?;
                self.write(place, value);
                self.run_for(place, *compare, limit, body.as_deref(), stmt.range, false)
            }
            StmtKind::Switch { scrutinee, cases } => {
                let Some(scrutinee) = scrutinee else {
                    return Err(self.stop_not_run("an empty switch".to_owned(), stmt.range));
                };
                let value = self.eval(scrutinee)?;
                let mut chosen = None;
                for (index, case) in cases.iter().enumerate() {
                    if let Some(label) = &case.label {
                        let label_value = self.eval(label)?;
                        if self.values_equal(&value, &label_value, label.range)? {
                            chosen = Some(index);
                            break;
                        }
                    }
                }
                let chosen = chosen.or_else(|| cases.iter().position(|case| case.label.is_none()));
                match chosen {
                    Some(index) => {
                        self.push_scope();
                        let flow = self.run_list(&cases[index].body, None);
                        self.pop_scope();
                        match flow? {
                            Flow::Break => Ok(Flow::Normal),
                            other => Ok(other),
                        }
                    }
                    None => Ok(Flow::Normal),
                }
            }
            StmtKind::Break => Ok(Flow::Break),
            StmtKind::Continue => Ok(Flow::Continue),
            StmtKind::Return(value) => {
                let value = match value {
                    Some(value) => self.eval(value)?,
                    None => Value::Void,
                };
                Ok(Flow::Return(value))
            }
            StmtKind::Goto(Some(label)) => {
                self.topics.insert(Topic::Goto);
                Ok(Flow::Goto(label.text.as_str()))
            }
            StmtKind::Goto(None) => {
                Err(self.stop_not_run("a goto without a label".to_owned(), stmt.range))
            }
            StmtKind::Label(_)
            | StmtKind::Dbg(_)
            | StmtKind::Breakpoint
            | StmtKind::Pragma { .. }
            | StmtKind::Class(_)
            | StmtKind::Empty => Ok(Flow::Normal),
            StmtKind::Error => {
                Err(self.stop_not_run("a statement that does not compile".to_owned(), stmt.range))
            }
        }
    }

    fn run_while(
        &mut self,
        condition: Option<&'p Expr>,
        body: Option<&'p Stmt>,
        range: ByteRange,
    ) -> Exec<Flow<'p>> {
        loop {
            if !self.condition(condition, range)? {
                return Ok(Flow::Normal);
            }
            let flow = match body {
                Some(body) => self.exec_scoped(body)?,
                None => {
                    self.step(range)?;
                    Flow::Normal
                }
            };
            match flow {
                Flow::Normal | Flow::Continue => {}
                Flow::Break => return Ok(Flow::Normal),
                other => return Ok(other),
            }
        }
    }

    fn run_for(
        &mut self,
        place: Place,
        compare: CompareOp,
        limit: &'p Expr,
        body: Option<&'p Stmt>,
        range: ByteRange,
        step_first: bool,
    ) -> Exec<Flow<'p>> {
        let mut step = step_first;
        loop {
            if step {
                let current = self.read(place).clone();
                let delta = if matches!(compare, CompareOp::Less | CompareOp::LessEq) {
                    AssignOp::Increment
                } else {
                    AssignOp::Decrement
                };
                let next = self.increment(current, delta, range)?;
                self.write(place, next);
            }
            step = true;
            let current = self.read(place).clone();
            let limit_value = self.eval(limit)?;
            let op = match compare {
                CompareOp::Less => BinaryOp::Less,
                CompareOp::LessEq => BinaryOp::LessEq,
                CompareOp::Greater => BinaryOp::Greater,
                CompareOp::GreaterEq => BinaryOp::GreaterEq,
            };
            let keep = self.binary(op, current, limit_value, range)?;
            if !self.truth(&keep, range)? {
                return Ok(Flow::Normal);
            }
            let flow = match body {
                Some(body) => self.exec_scoped(body)?,
                None => {
                    self.step(range)?;
                    Flow::Normal
                }
            };
            match flow {
                Flow::Normal | Flow::Continue => {}
                Flow::Break => return Ok(Flow::Normal),
                other => return Ok(other),
            }
        }
    }

    fn for_variable(&mut self, name: &'p Name) -> Exec<Place> {
        if let Some(place) = self.lookup(&name.text) {
            return Ok(place);
        }
        let frame = self.frame_mut();
        frame
            .vars
            .push((name.text.as_str(), Binding::Value(Value::Int(0))));
        Ok(Place::Local(frame.vars.len() - 1))
    }

    fn resume_stmt(&mut self, stmt: &'p Stmt, label: &'p str) -> Exec<Flow<'p>> {
        match &stmt.kind {
            StmtKind::Block(block) => {
                self.push_scope();
                let flow = self.run_list(&block.stmts, Some(label));
                self.pop_scope();
                flow
            }
            StmtKind::If {
                then_branch,
                else_branch,
                ..
            } => {
                let branch = [then_branch, else_branch]
                    .into_iter()
                    .flatten()
                    .find(|branch| contains_label(branch, label));
                match branch {
                    Some(branch) => self.resume_in(branch, label),
                    None => Ok(Flow::Goto(label)),
                }
            }
            StmtKind::While { condition, body } => {
                let Some(body) = body else {
                    return Ok(Flow::Goto(label));
                };
                match self.resume_in(body, label)? {
                    Flow::Normal | Flow::Continue => {
                        self.run_while(condition.as_ref(), Some(body), stmt.range)
                    }
                    Flow::Break => Ok(Flow::Normal),
                    other => Ok(other),
                }
            }
            StmtKind::For {
                variable: Some(variable),
                compare: Some(compare),
                limit: Some(limit),
                body: Some(body),
                ..
            } => {
                let place = self.for_variable(variable)?;
                match self.resume_in(body, label)? {
                    Flow::Normal | Flow::Continue => {
                        self.run_for(place, *compare, limit, Some(body), stmt.range, true)
                    }
                    Flow::Break => Ok(Flow::Normal),
                    other => Ok(other),
                }
            }
            StmtKind::Switch { cases, .. } => {
                let Some(case) = cases
                    .iter()
                    .find(|case| case.body.iter().any(|stmt| contains_label(stmt, label)))
                else {
                    return Ok(Flow::Goto(label));
                };
                self.push_scope();
                let flow = self.run_list(&case.body, Some(label));
                self.pop_scope();
                match flow? {
                    Flow::Break => Ok(Flow::Normal),
                    other => Ok(other),
                }
            }
            _ => Ok(Flow::Goto(label)),
        }
    }

    fn resume_in(&mut self, stmt: &'p Stmt, label: &'p str) -> Exec<Flow<'p>> {
        if is_label(stmt, label) {
            return Ok(Flow::Normal);
        }
        self.push_scope();
        let flow = self.resume_stmt(stmt, label);
        self.pop_scope();
        flow
    }

    fn find_label(&mut self, stmts: &'p [Stmt], label: &str) -> Exec<Option<(usize, bool)>> {
        for (index, stmt) in stmts.iter().enumerate() {
            self.step(stmt.range)?;
            if is_label(stmt, label) {
                return Ok(Some((index, true)));
            }
            if contains_label(stmt, label) {
                return Ok(Some((index, false)));
            }
        }
        Ok(None)
    }

    fn declare_local(&mut self, variable: &'p VarDecl) -> Exec<()> {
        let kind = self.kind_of(&variable.ty, variable.name.range)?;
        if is_static(&variable.modifiers) {
            let key = (self.file, variable.range.start.0);
            if !self.statics.contains_key(&key) {
                let value = match &variable.init {
                    Some(init) => {
                        let value = self.eval(init)?;
                        self.convert(value, kind, init.range, false)?
                    }
                    None => self.default_of(kind, variable.name.range, 0)?,
                };
                self.statics.insert(key, value);
            }
            self.frame_mut()
                .vars
                .push((variable.name.text.as_str(), Binding::Static(key)));
            return Ok(());
        }
        let value = match &variable.init {
            Some(init) => {
                let value = self.eval(init)?;
                self.convert(value, kind, init.range, false)?
            }
            None => self.default_of(kind, variable.name.range, 0)?,
        };
        self.frame_mut()
            .vars
            .push((variable.name.text.as_str(), Binding::Value(value)));
        Ok(())
    }

    fn assign(
        &mut self,
        target: &'p Expr,
        op: AssignOp,
        value: Option<&'p Expr>,
        range: ByteRange,
    ) -> Exec<()> {
        let (root, members) = self.assignment_path(target)?;
        let Some(place) = self.lookup(&root.text) else {
            return Err(self.stop_unknown_name(root));
        };
        let current = self.member_value(place, &members, target.range)?;
        let next = match op {
            AssignOp::Assign => {
                let Some(value) = value else {
                    return Err(
                        self.stop_not_run("an assignment without a value".to_owned(), range)
                    );
                };
                let evaluated = self.eval(value)?;
                self.convert(evaluated, current.kind(), value.range, false)?
            }
            AssignOp::Increment | AssignOp::Decrement => self.increment(current, op, range)?,
        };
        self.store_member(place, &members, next);
        Ok(())
    }

    fn assignment_path(&mut self, target: &'p Expr) -> Exec<(&'p Name, Vec<&'p str>)> {
        let mut members = Vec::new();
        let mut current = target;
        loop {
            match &current.kind {
                ExprKind::Name(name) => {
                    members.reverse();
                    return Ok((name, members));
                }
                ExprKind::Member { object, member } => {
                    members.push(member.text.as_str());
                    current = object;
                }
                ExprKind::Paren(inner) => current = inner,
                _ => {
                    return Err(self.stop_not_run(
                        "an assignment to something that is not a variable".to_owned(),
                        target.range,
                    ));
                }
            }
        }
    }

    fn member_value(&mut self, place: Place, members: &[&str], range: ByteRange) -> Exec<Value> {
        let mut value = self.read(place);
        for member in members {
            let Value::Object(object) = value else {
                return Err(self.stop_not_run(
                    format!("member {member} of a value that is not a class"),
                    range,
                ));
            };
            let Some(index) = self.member_index(object.class, member) else {
                return Err(self.stop_not_run(format!("unknown member {member}"), range));
            };
            value = &object.members[index];
        }
        Ok(value.clone())
    }

    fn store_member(&mut self, place: Place, members: &[&str], next: Value) {
        let program = self.program;
        let mut slot = self.slot_mut(place);
        for member in members {
            let Value::Object(object) = slot else {
                return;
            };
            let class = program.class(object.class);
            let Some(index) = class
                .members
                .iter()
                .position(|candidate| candidate.name.text == *member)
            else {
                return;
            };
            slot = &mut object.members[index];
        }
        *slot = next;
    }

    fn member_index(&self, class: usize, member: &str) -> Option<usize> {
        self.program
            .class(class)
            .members
            .iter()
            .position(|candidate| candidate.name.text == member)
    }

    fn increment(&mut self, current: Value, op: AssignOp, range: ByteRange) -> Exec<Value> {
        let delta = if op == AssignOp::Increment { 1 } else { -1 };
        match current {
            Value::Int(value) => {
                let (next, wrapped) = value.overflowing_add(delta);
                if wrapped {
                    self.wrapped(next, range);
                }
                Ok(Value::Int(next))
            }
            Value::Float(value) => Ok(Value::Float(value + delta as f32)),
            other => Err(self.stop_not_run(
                format!("++ or -- on a {} value", other.kind().label()),
                range,
            )),
        }
    }

    fn condition(&mut self, condition: Option<&'p Expr>, range: ByteRange) -> Exec<bool> {
        let Some(condition) = condition else {
            return Err(self.stop_not_run("a missing condition".to_owned(), range));
        };
        let value = self.eval(condition)?;
        self.truth(&value, condition.range)
    }

    pub(crate) fn truth(&mut self, value: &Value, range: ByteRange) -> Exec<bool> {
        match value {
            Value::Int(value) => Ok(*value != 0),
            Value::Float(value) => Ok(*value != 0.0),
            Value::Bool(value) => Ok(*value),
            other => Err(self.stop_not_run(
                format!("a {} value used as a condition", other.kind().label()),
                range,
            )),
        }
    }

    pub(crate) fn eval(&mut self, expr: &'p Expr) -> Exec<Value> {
        self.step(expr.range)?;
        match &expr.kind {
            ExprKind::Literal(literal) => Ok(match literal {
                Literal::Integer(value) => {
                    let wrapped = *value as i32;
                    if i64::from(wrapped) != *value {
                        self.wrapped(wrapped, expr.range);
                    }
                    Value::Int(wrapped)
                }
                Literal::Float(value) => Value::Float(*value as f32),
                Literal::Bool(value) => Value::Bool(*value),
                Literal::String(value) => {
                    let bytes = value.as_bytes().to_vec();
                    self.new_text(bytes, expr.range)?
                }
            }),
            ExprKind::Name(name) => match self.lookup(&name.text) {
                Some(place) => Ok(self.read(place).clone()),
                None => Err(self.stop_unknown_name(name)),
            },
            ExprKind::Unary { op, operand } => {
                let value = self.eval(operand)?;
                match op {
                    UnaryOp::Plus => Ok(value),
                    UnaryOp::Negate => self.negate(value, expr.range),
                }
            }
            ExprKind::Binary { op, left, right } => match op {
                BinaryOp::And | BinaryOp::Or => {
                    let left_value = self.eval(left)?;
                    let left_truth = self.truth(&left_value, left.range)?;
                    if (*op == BinaryOp::And) != left_truth {
                        return Ok(Value::Bool(left_truth));
                    }
                    let right_value = self.eval(right)?;
                    Ok(Value::Bool(self.truth(&right_value, right.range)?))
                }
                _ => {
                    let left_value = self.eval(left)?;
                    let right_value = self.eval(right)?;
                    self.binary(*op, left_value, right_value, expr.range)
                }
            },
            ExprKind::Call { callee, args, .. } => self.call(callee, args, expr.range),
            ExprKind::Cast { ty, operand } => {
                let kind = ValueKind::from_type_name(*ty);
                let value = match operand {
                    Some(operand) => self.eval(operand)?,
                    None => return self.default_of(kind, expr.range, 0),
                };
                match kind {
                    ValueKind::Bool => {
                        let truth = self.truth(&value, expr.range)?;
                        Ok(Value::Bool(truth))
                    }
                    ValueKind::Str => {
                        if !matches!(value, Value::Str(_)) {
                            self.topics.insert(Topic::NumberText);
                        }
                        match number_text(&value) {
                            Some(bytes) => self.new_text(bytes, expr.range),
                            None => Err(self.stop_not_run(
                                format!("string() of a {} value", value.kind().label()),
                                expr.range,
                            )),
                        }
                    }
                    _ => self.convert(value, kind, expr.range, false),
                }
            }
            ExprKind::ParenthesizedType { ty, .. } => Ok(match ty {
                TypeName::Int => Value::Int(0),
                TypeName::Float => Value::Float(0.0),
                TypeName::Bool => Value::Bool(true),
                other => Value::text(other.as_str()),
            }),
            ExprKind::Vector(components) => {
                let mut values = [0.0f32; 3];
                for (slot, component) in values.iter_mut().zip(components) {
                    let value = self.eval(component)?;
                    *slot = match value.as_f32() {
                        Some(number) => number,
                        None => {
                            return Err(self.stop_not_run(
                                format!("a {} value in vector()", value.kind().label()),
                                component.range,
                            ));
                        }
                    };
                }
                Ok(Value::Vector(values))
            }
            ExprKind::Member { object, member } => {
                let value = self.eval(object)?;
                let Value::Object(object) = value else {
                    return Err(self.stop_not_run(
                        format!("member {} of a value that is not a class", member.text),
                        expr.range,
                    ));
                };
                match self.member_index(object.class, &member.text) {
                    Some(index) => Ok(object.members[index].clone()),
                    None => {
                        Err(self
                            .stop_not_run(format!("unknown member {}", member.text), expr.range))
                    }
                }
            }
            ExprKind::Paren(inner) => self.eval(inner),
            ExprKind::Error => {
                Err(self.stop_not_run("an expression that does not compile".to_owned(), expr.range))
            }
        }
    }

    fn negate(&mut self, value: Value, range: ByteRange) -> Exec<Value> {
        match value {
            Value::Int(value) => {
                let (next, wrapped) = value.overflowing_neg();
                if wrapped {
                    self.wrapped(next, range);
                }
                Ok(Value::Int(next))
            }
            Value::Float(value) => Ok(Value::Float(-value)),
            Value::Bool(value) => Ok(Value::Int(-i32::from(value))),
            Value::Vector([x, y, z]) => Ok(Value::Vector([-x, -y, -z])),
            other => Err(self.stop_not_run(
                format!("a minus sign before a {} value", other.kind().label()),
                range,
            )),
        }
    }

    pub(crate) fn binary(
        &mut self,
        op: BinaryOp,
        left: Value,
        right: Value,
        range: ByteRange,
    ) -> Exec<Value> {
        if op == BinaryOp::Add && (matches!(left, Value::Str(_)) || matches!(right, Value::Str(_)))
        {
            return self.concatenate(&left, &right, range);
        }
        if op.is_comparison() {
            return self.compare(op, &left, &right, range);
        }
        match (&left, &right) {
            (Value::Vector(a), Value::Vector(b)) => {
                return match op {
                    BinaryOp::Add => Ok(Value::Vector([a[0] + b[0], a[1] + b[1], a[2] + b[2]])),
                    BinaryOp::Sub => Ok(Value::Vector([a[0] - b[0], a[1] - b[1], a[2] - b[2]])),
                    _ => Err(self.stop_operator(op, &left, &right, range)),
                };
            }
            (Value::Vector(vector), number) | (number, Value::Vector(vector))
                if number.is_number_like() =>
            {
                let factor = number.as_f32().unwrap_or_default();
                let vector_left = matches!(left, Value::Vector(_));
                return match op {
                    BinaryOp::Mul => Ok(Value::Vector(vector.map(|part| part * factor))),
                    BinaryOp::Div if vector_left => {
                        if factor == 0.0 {
                            return Err(self.stop_division(StopCode::DivisionByZero, range));
                        }
                        Ok(Value::Vector(vector.map(|part| part / factor)))
                    }
                    _ => Err(self.stop_operator(op, &left, &right, range)),
                };
            }
            _ => {}
        }
        if !left.is_number_like() || !right.is_number_like() {
            return Err(self.stop_operator(op, &left, &right, range));
        }
        if matches!(op, BinaryOp::BitAnd | BinaryOp::BitOr) {
            if let (Value::Bool(a), Value::Bool(b)) = (&left, &right) {
                return Ok(Value::Bool(if op == BinaryOp::BitAnd {
                    *a & *b
                } else {
                    *a | *b
                }));
            }
            let a = self.whole(&left, range);
            let b = self.whole(&right, range);
            return Ok(Value::Int(if op == BinaryOp::BitAnd {
                a & b
            } else {
                a | b
            }));
        }
        let left_int = !matches!(left, Value::Float(_));
        let right_int = !matches!(right, Value::Float(_));
        if left_int && right_int {
            let a = self.whole(&left, range);
            let b = self.whole(&right, range);
            return self.integer_arithmetic(op, a, b, range);
        }
        self.topics.insert(Topic::MixedNumbers);
        if op == BinaryOp::Mod {
            let a = self.whole(&left, range);
            let b = self.whole(&right, range);
            if b == 0 {
                return Err(self.stop_division(StopCode::RemainderByZero, range));
            }
            let remainder = a.wrapping_rem(b);
            return Ok(if left_int {
                Value::Int(remainder)
            } else {
                Value::Float(remainder as f32)
            });
        }
        let a = left.as_f32().unwrap_or_default();
        let b = right.as_f32().unwrap_or_default();
        let result = match op {
            BinaryOp::Add => a + b,
            BinaryOp::Sub => a - b,
            BinaryOp::Mul => a * b,
            BinaryOp::Div => {
                if b == 0.0 {
                    return Err(self.stop_division(StopCode::DivisionByZero, range));
                }
                a / b
            }
            _ => return Err(self.stop_operator(op, &left, &right, range)),
        };
        if left_int {
            let (value, unusual) = float_to_int(result);
            if unusual {
                self.topics.insert(Topic::IntegerArithmetic);
            }
            Ok(Value::Int(value))
        } else {
            Ok(Value::Float(result))
        }
    }

    fn integer_arithmetic(
        &mut self,
        op: BinaryOp,
        a: i32,
        b: i32,
        range: ByteRange,
    ) -> Exec<Value> {
        let (value, wrapped) = match op {
            BinaryOp::Add => a.overflowing_add(b),
            BinaryOp::Sub => a.overflowing_sub(b),
            BinaryOp::Mul => a.overflowing_mul(b),
            BinaryOp::Div => {
                if b == 0 {
                    return Err(self.stop_division(StopCode::DivisionByZero, range));
                }
                if (a < 0) != (b < 0) && a % b != 0 {
                    self.topics.insert(Topic::IntegerArithmetic);
                }
                a.overflowing_div(b)
            }
            BinaryOp::Mod => {
                if b == 0 {
                    return Err(self.stop_division(StopCode::RemainderByZero, range));
                }
                if a < 0 || b < 0 {
                    self.topics.insert(Topic::IntegerArithmetic);
                }
                a.overflowing_rem(b)
            }
            _ => {
                return Err(self.stop_operator(op, &Value::Int(a), &Value::Int(b), range));
            }
        };
        if wrapped {
            self.wrapped(value, range);
        }
        Ok(Value::Int(value))
    }

    fn whole(&mut self, value: &Value, _range: ByteRange) -> i32 {
        match value {
            Value::Int(value) => *value,
            Value::Bool(value) => i32::from(*value),
            Value::Float(value) => {
                let (whole, unusual) = float_to_int(*value);
                if unusual {
                    self.topics.insert(Topic::IntegerArithmetic);
                }
                whole
            }
            _ => 0,
        }
    }

    fn compare(
        &mut self,
        op: BinaryOp,
        left: &Value,
        right: &Value,
        range: ByteRange,
    ) -> Exec<Value> {
        use std::cmp::Ordering as O;
        let ordering = match (left, right) {
            (Value::Str(a), Value::Str(b)) => Some(a.as_ref().cmp(b.as_ref())),
            (Value::Vector(a), Value::Vector(b)) => {
                return match op {
                    BinaryOp::Eq => Ok(Value::Bool(a == b)),
                    BinaryOp::NotEq => Ok(Value::Bool(a != b)),
                    _ => Err(self.stop_operator(op, left, right, range)),
                };
            }
            (a, b) if a.is_number_like() && b.is_number_like() => {
                if matches!(a, Value::Float(_)) || matches!(b, Value::Float(_)) {
                    let x = a.as_f32().unwrap_or_default();
                    let y = b.as_f32().unwrap_or_default();
                    x.partial_cmp(&y)
                } else {
                    let x = self.whole(a, range);
                    let y = self.whole(b, range);
                    Some(x.cmp(&y))
                }
            }
            _ => return Err(self.stop_operator(op, left, right, range)),
        };
        let result = match ordering {
            None => op == BinaryOp::NotEq,
            Some(ordering) => match op {
                BinaryOp::Eq => ordering == O::Equal,
                BinaryOp::NotEq => ordering != O::Equal,
                BinaryOp::Less => ordering == O::Less,
                BinaryOp::LessEq => ordering != O::Greater,
                BinaryOp::Greater => ordering == O::Greater,
                _ => ordering != O::Less,
            },
        };
        Ok(Value::Bool(result))
    }

    fn values_equal(&mut self, left: &Value, right: &Value, range: ByteRange) -> Exec<bool> {
        let result = self.compare(BinaryOp::Eq, left, right, range)?;
        Ok(matches!(result, Value::Bool(true)))
    }

    fn concatenate(&mut self, left: &Value, right: &Value, range: ByteRange) -> Exec<Value> {
        let mut bytes = Vec::new();
        for value in [left, right] {
            if !matches!(value, Value::Str(_)) {
                self.topics.insert(Topic::NumberText);
            }
            match number_text(value) {
                Some(text) => bytes.extend_from_slice(&text),
                None => {
                    return Err(self.stop_not_run(
                        format!("joining text with a {} value", value.kind().label()),
                        range,
                    ));
                }
            }
        }
        self.new_text(bytes, range)
    }

    pub(crate) fn convert(
        &mut self,
        value: Value,
        kind: ValueKind,
        range: ByteRange,
        boundary: bool,
    ) -> Exec<Value> {
        if value.kind() == kind {
            return Ok(value);
        }
        let converted = match (kind, &value) {
            (ValueKind::Int, Value::Float(number)) => {
                let (whole, unusual) = float_to_int(*number);
                if unusual {
                    self.topics.insert(Topic::IntegerArithmetic);
                }
                if boundary {
                    self.topics.insert(Topic::MixedNumbers);
                }
                Value::Int(whole)
            }
            (ValueKind::Int, Value::Bool(truth)) => Value::Int(i32::from(*truth)),
            (ValueKind::Float, Value::Int(number)) => {
                if boundary {
                    self.topics.insert(Topic::MixedNumbers);
                }
                Value::Float(*number as f32)
            }
            (ValueKind::Float, Value::Bool(truth)) => Value::Float(if *truth { 1.0 } else { 0.0 }),
            (ValueKind::Bool, Value::Int(number)) => Value::Bool(*number != 0),
            (ValueKind::Bool, Value::Float(number)) => Value::Bool(*number != 0.0),
            (ValueKind::Str, other) if !matches!(other, Value::Object(_) | Value::Void) => {
                self.topics.insert(Topic::NumberText);
                let bytes = number_text(other).unwrap_or_default();
                self.new_text(bytes, range)?
            }
            (ValueKind::Void, _) => Value::Void,
            _ => {
                return Err(self.stop_not_run(
                    format!(
                        "a {} value where the script expects {}",
                        value.kind().label(),
                        kind.label()
                    ),
                    range,
                ));
            }
        };
        Ok(converted)
    }

    fn call(&mut self, callee: &'p Name, args: &'p [Expr], range: ByteRange) -> Exec<Value> {
        let name = callee.text.as_str();
        if let Some(at) = self.program.functions.get(name).copied() {
            let mut values = Vec::with_capacity(args.len());
            for arg in args {
                values.push(self.eval(arg)?);
            }
            return self.call_user(at, values, range);
        }
        if self
            .program
            .function_order
            .iter()
            .any(|known| known == name)
        {
            return Err(self.stop_not_run(format!("function {name} without a body"), range));
        }
        let catalog = xs_analysis::catalog().ok();
        let Some(builtin) = catalog.and_then(|catalog| catalog.get(name)) else {
            return Err(self.stop_unanswered(
                name,
                Unanswered::Reason(UnansweredReason::UnknownCall),
                callee.range,
            ));
        };
        let params = builtin.params_for(self.program.build);
        let mut values = Vec::with_capacity(params.len().max(args.len()));
        for arg in args {
            values.push(self.eval(arg)?);
        }
        let mut converted = Vec::with_capacity(params.len());
        for (index, param) in params.iter().enumerate() {
            let kind = ty_kind(&param.ty);
            let value = match values.get(index) {
                Some(value) => value.clone(),
                None => match &param.default {
                    Some(DefaultValue::Integer(value)) => Value::Int(*value as i32),
                    Some(DefaultValue::Bool(value)) => Value::Bool(*value),
                    Some(DefaultValue::String(value)) => Value::text(value),
                    None => match kind.and_then(zero_value) {
                        Some(value) => value,
                        None => Value::Void,
                    },
                },
            };
            converted.push(match kind {
                Some(kind) => self.convert(value, kind, range, false)?,
                None => value,
            });
        }
        let class = call_table()
            .ok()
            .and_then(|table| table.get(name))
            .map_or(CallClass::Refused, |entry| entry.class);
        let result = match class {
            CallClass::Pure => self.pure_builtin(name, &converted, range)?,
            CallClass::Random => self.random_builtin(name, &converted, callee.range),
            _ => {
                if class == CallClass::StartDefault {
                    self.topics.insert(Topic::StartDefaults);
                }
                let source_id = self.program.files.get(self.file).map(|file| file.id());
                let answer = self.host.call(&HostCall {
                    name,
                    class,
                    args: &converted,
                    source_id,
                    range: callee.range,
                    context_player: self.context_player,
                });
                for note in self.host.take_notes() {
                    match note {
                        HostNote::Topic(topic) => {
                            self.topics.insert(topic);
                        }
                        HostNote::Finding {
                            code,
                            severity,
                            message,
                            arguments,
                        } => self.finding(code, severity, message, arguments, callee.range),
                    }
                }
                match answer {
                    HostAnswer::Value(value) => value,
                    HostAnswer::Void => Value::Void,
                    HostAnswer::IntArray { array, items } => {
                        self.host_int_array(array, items, callee.range)?
                    }
                    HostAnswer::Unanswered(reason) => {
                        return Err(self.stop_unanswered(name, reason, callee.range));
                    }
                }
            }
        };
        match ty_kind(&builtin.return_type_for(self.program.build)) {
            Some(ValueKind::Void) => Ok(Value::Void),
            Some(kind) => self.convert(result, kind, range, false),
            None => Ok(result),
        }
    }

    fn host_int_array(&mut self, array: i32, items: Vec<i32>, range: ByteRange) -> Exec<Value> {
        let size = i32::try_from(items.len()).unwrap_or(i32::MAX);
        let id = if array < 0 {
            let id =
                self.create_array(ValueKind::Int, size, Value::Int(0), String::new(), range)?;
            if id < 0 {
                return Ok(Value::Int(-1));
            }
            id
        } else {
            let old_size = match self.array(ValueKind::Int, array) {
                Some(found) => found.items.len(),
                None => {
                    self.unknown_array_write(array, range);
                    return Ok(Value::Int(-1));
                }
            };
            if items.len() > old_size {
                if self.arrays.items + (items.len() - old_size) > MAXIMUM_ARRAY_ITEMS {
                    return Err(self.stop_memory("arrayItems", range));
                }
                self.charge(items.len() - old_size, range)?;
                self.arrays.items += items.len() - old_size;
            } else {
                self.arrays.items -= old_size - items.len();
            }
            array
        };
        self.arrays.list[id as usize].items = items.into_iter().map(Value::Int).collect();
        Ok(Value::Int(id))
    }

    fn random_builtin(&mut self, name: &str, args: &[Value], range: ByteRange) -> Value {
        if self.random_draws == 0 {
            self.finding(
                "XS5011",
                FindingSeverity::Information,
                "Random numbers come from the IDE's own stream, not the game's".to_owned(),
                vec![("call", name.to_owned())],
                range,
            );
        }
        self.random_draws = self.random_draws.saturating_add(1);
        let int = |index: usize| match args.get(index) {
            Some(Value::Int(value)) => *value,
            _ => 0,
        };
        Value::Int(match name {
            "xsGetRandomNumberLH" => self.random.low_high(int(0), int(1)),
            "xsGetRandomNumberMax" => self.random.max(int(0)),
            _ => self.random.number(),
        })
    }

    fn frame_mut(&mut self) -> &mut Frame<'p> {
        self.frames.last_mut().expect("a running frame")
    }

    fn push_scope(&mut self) {
        if let Some(frame) = self.frames.last_mut() {
            let mark = frame.vars.len();
            frame.marks.push(mark);
        }
    }

    fn pop_scope(&mut self) {
        if let Some(frame) = self.frames.last_mut()
            && let Some(mark) = frame.marks.pop()
        {
            frame.vars.truncate(mark);
        }
    }

    fn lookup(&self, name: &str) -> Option<Place> {
        if let Some(frame) = self.frames.last()
            && let Some(index) = frame
                .vars
                .iter()
                .rposition(|(candidate, _)| *candidate == name)
        {
            return Some(match frame.vars[index].1 {
                Binding::Value(_) => Place::Local(index),
                Binding::Static(key) => Place::Static(key),
            });
        }
        self.global_index.get(name).map(|slot| Place::Global(*slot))
    }

    pub(crate) fn variable(&self, name: &str) -> Option<&Value> {
        self.lookup(name).map(|place| self.read(place))
    }

    fn read(&self, place: Place) -> &Value {
        match place {
            Place::Local(index) => {
                match &self.frames.last().expect("a running frame").vars[index].1 {
                    Binding::Value(value) => value,
                    Binding::Static(key) => &self.statics[key],
                }
            }
            Place::Static(key) => &self.statics[&key],
            Place::Global(slot) => &self.globals[slot],
        }
    }

    fn slot_mut(&mut self, place: Place) -> &mut Value {
        match place {
            Place::Local(index) => {
                let frame = self.frames.last_mut().expect("a running frame");
                match &mut frame.vars[index].1 {
                    Binding::Value(value) => value,
                    Binding::Static(key) => self.statics.get_mut(key).expect("a static"),
                }
            }
            Place::Static(key) => self.statics.get_mut(&key).expect("a static"),
            Place::Global(slot) => &mut self.globals[slot],
        }
    }

    fn write(&mut self, place: Place, value: Value) {
        *self.slot_mut(place) = value;
    }

    fn kind_of(&mut self, ty: &TypeRef, range: ByteRange) -> Exec<ValueKind> {
        match ty {
            TypeRef::Builtin(name, _) => Ok(ValueKind::from_type_name(*name)),
            TypeRef::Class(name) => match self.program.class_index.get(&name.text) {
                Some(index) => Ok(ValueKind::Object(*index)),
                None => Err(self.stop_not_run(format!("unknown class {}", name.text), range)),
            },
        }
    }

    fn default_of(&mut self, kind: ValueKind, range: ByteRange, nesting: u32) -> Exec<Value> {
        if let Some(value) = zero_value(kind) {
            return Ok(value);
        }
        let ValueKind::Object(class) = kind else {
            return Ok(Value::Void);
        };
        if nesting >= MAXIMUM_CLASS_NESTING {
            return Err(self.stop_not_run("classes nested too deeply".to_owned(), range));
        }
        let declaration = self.program.class(class);
        let mut members = Vec::with_capacity(declaration.members.len());
        for member in &declaration.members {
            let member_kind = self.kind_of(&member.ty, member.name.range)?;
            let value = match &member.init {
                Some(init) => {
                    let value = self.eval(init)?;
                    self.convert(value, member_kind, init.range, false)?
                }
                None => self.default_of(member_kind, member.name.range, nesting + 1)?,
            };
            members.push(value);
        }
        Ok(Value::Object(Box::new(Object { class, members })))
    }

    fn step(&mut self, range: ByteRange) -> Exec<()> {
        if !self.counting {
            return Ok(());
        }
        self.steps += 1;
        if self.steps > self.step_limit {
            self.steps = self.step_limit;
            let limit = self.step_limit;
            return Err(self.stop(
                StopCode::StepLimit,
                format!("The XS start check stopped after {limit} steps"),
                vec![("limit", limit.to_string())],
                range,
                None,
                None,
            ));
        }
        if self.steps >= self.next_cancel_check {
            self.next_cancel_check = self.steps + CANCEL_CHECK_INTERVAL;
            if self.cancelled.is_some_and(|cancelled| cancelled()) {
                return Err(Halt::Cancelled);
            }
        }
        Ok(())
    }

    pub(crate) fn charge(&mut self, units: usize, range: ByteRange) -> Exec<()> {
        if !self.counting || units < 64 {
            return Ok(());
        }
        let extra = (units / 64) as u64;
        self.steps = self.steps.saturating_add(extra.saturating_sub(1));
        self.step(range)
    }

    pub(crate) fn new_text(&mut self, bytes: Vec<u8>, range: ByteRange) -> Exec<Value> {
        if bytes.len() > MAXIMUM_TEXT_BYTES {
            return Err(self.stop_memory("text", range));
        }
        self.text_total += bytes.len();
        if self.text_total > MAXIMUM_TEXT_TOTAL_BYTES {
            return Err(self.stop_memory("textTotal", range));
        }
        self.charge(bytes.len(), range)?;
        Ok(Value::Str(Arc::from(bytes)))
    }

    pub(crate) fn wrapped(&mut self, value: i32, range: ByteRange) {
        self.topics.insert(Topic::IntegerArithmetic);
        self.finding(
            "XS5007",
            FindingSeverity::Warning,
            format!("A whole number went past its range and wrapped to {value}"),
            vec![("value", value.to_string())],
            range,
        );
    }

    pub(crate) fn finding(
        &mut self,
        code: &'static str,
        severity: FindingSeverity,
        message: String,
        arguments: Vec<(&'static str, String)>,
        range: ByteRange,
    ) {
        let key = (code, self.file, range.start.0, range.end.0);
        if let Some(index) = self.finding_index.get(&key) {
            let finding = &mut self.findings[*index];
            finding.count = finding.count.saturating_add(1);
            return;
        }
        if self.findings.len() >= MAXIMUM_FINDINGS {
            self.omitted_findings = self.omitted_findings.saturating_add(1);
            return;
        }
        self.finding_index.insert(key, self.findings.len());
        let source_id = self
            .program
            .files
            .get(self.file)
            .map(|file| file.id().clone());
        self.findings.push(Finding {
            code,
            severity,
            message,
            arguments,
            source_id,
            range: Some(range),
            count: 1,
        });
    }

    fn stop(
        &self,
        code: StopCode,
        message: String,
        arguments: Vec<(&'static str, String)>,
        range: ByteRange,
        call: Option<String>,
        reason: Option<Unanswered>,
    ) -> Halt {
        let frame = self.frames.last();
        Halt::Stop(Box::new(Stop {
            code,
            message,
            arguments,
            source_id: self
                .program
                .files
                .get(self.file)
                .map(|file| file.id().clone()),
            range: Some(range),
            function: frame.map(|frame| frame.name.to_owned()),
            in_rule: frame.is_some_and(|frame| frame.in_rule),
            call,
            reason,
        }))
    }

    pub(crate) fn stop_not_run(&self, construct: String, range: ByteRange) -> Halt {
        self.stop(
            StopCode::NotRun,
            format!("The XS start check stopped at {construct}, which it does not run"),
            vec![("construct", construct)],
            range,
            None,
            None,
        )
    }

    fn stop_unknown_name(&self, name: &Name) -> Halt {
        self.stop_not_run(format!("the unknown name {}", name.text), name.range)
    }

    fn stop_goto(&self, label: &str, range: ByteRange) -> Halt {
        self.stop_not_run(
            format!("goto {label}, whose label it could not find"),
            range,
        )
    }

    fn stop_depth(&self, range: ByteRange) -> Halt {
        let depth = self.depth_limit;
        self.stop(
            StopCode::CallDepth,
            format!("The XS start check stopped at call depth {depth}"),
            vec![("depth", depth.to_string())],
            range,
            None,
            None,
        )
    }

    pub(crate) fn stop_division(&self, code: StopCode, range: ByteRange) -> Halt {
        let message = if code == StopCode::RemainderByZero {
            "Remainder of a division by zero; the run stops because the game's result is not known"
        } else {
            "Division by zero; the run stops because the game's result is not known"
        };
        self.stop(code, message.to_owned(), Vec::new(), range, None, None)
    }

    pub(crate) fn stop_memory(&self, bound: &'static str, range: ByteRange) -> Halt {
        let words = match bound {
            "arrays" => "arrays",
            "arrayItems" => "array items",
            "text" => "text in one value",
            _ => "text",
        };
        self.stop(
            StopCode::MemoryBound,
            format!(
                "The XS start check stopped: the script uses more {words} than the check allows"
            ),
            vec![("bound", bound.to_owned())],
            range,
            None,
            None,
        )
    }

    fn stop_unanswered(&self, call: &str, reason: Unanswered, range: ByteRange) -> Halt {
        self.stop(
            StopCode::Unanswered,
            format!("Stopped at {call}: {}", reason.text()),
            vec![
                ("call", call.to_owned()),
                ("reason", reason.argument().to_owned()),
            ],
            range,
            Some(call.to_owned()),
            Some(reason),
        )
    }

    fn stop_operator(&self, op: BinaryOp, left: &Value, right: &Value, range: ByteRange) -> Halt {
        self.stop_not_run(
            format!(
                "{} between {} and {} values",
                operator_text(op),
                left.kind().label(),
                right.kind().label()
            ),
            range,
        )
    }

    pub(crate) fn program_function_id(&self, name: &str) -> i32 {
        self.program
            .function_order
            .iter()
            .position(|candidate| candidate == name)
            .map_or(-1, |index| index as i32)
    }
}

fn operator_text(op: BinaryOp) -> &'static str {
    match op {
        BinaryOp::Or => "||",
        BinaryOp::And => "&&",
        BinaryOp::BitOr => "|",
        BinaryOp::BitAnd => "&",
        BinaryOp::Eq => "==",
        BinaryOp::NotEq => "!=",
        BinaryOp::Less => "<",
        BinaryOp::LessEq => "<=",
        BinaryOp::Greater => ">",
        BinaryOp::GreaterEq => ">=",
        BinaryOp::Add => "+",
        BinaryOp::Sub => "-",
        BinaryOp::Mul => "*",
        BinaryOp::Div => "/",
        BinaryOp::Mod => "%",
    }
}

fn is_static(modifiers: &Modifiers) -> bool {
    modifiers.static_.is_some()
}

fn ty_kind(ty: &Ty) -> Option<ValueKind> {
    Some(match ty {
        Ty::Int => ValueKind::Int,
        Ty::Float => ValueKind::Float,
        Ty::Bool => ValueKind::Bool,
        Ty::String => ValueKind::Str,
        Ty::Vector => ValueKind::Vector,
        Ty::Void => ValueKind::Void,
        Ty::Class(_) | Ty::Unknown => return None,
    })
}

fn is_label(stmt: &Stmt, label: &str) -> bool {
    matches!(&stmt.kind, StmtKind::Label(Some(name)) if name.text == label)
}

fn contains_label(stmt: &Stmt, label: &str) -> bool {
    match &stmt.kind {
        StmtKind::Label(Some(name)) => name.text == label,
        StmtKind::Block(block) => block.stmts.iter().any(|stmt| contains_label(stmt, label)),
        StmtKind::If {
            then_branch,
            else_branch,
            ..
        } => [then_branch, else_branch]
            .into_iter()
            .flatten()
            .any(|branch| contains_label(branch, label)),
        StmtKind::While { body, .. } | StmtKind::For { body, .. } => body
            .as_ref()
            .is_some_and(|body| contains_label(body, label)),
        StmtKind::Switch { cases, .. } => cases
            .iter()
            .any(|case| case.body.iter().any(|stmt| contains_label(stmt, label))),
        _ => false,
    }
}
