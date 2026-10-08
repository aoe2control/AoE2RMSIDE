use rms_source::ByteRange;

use crate::diagnostic::XsDiagnostic;
use crate::lexer::Token;

#[derive(Clone, Debug, PartialEq)]
pub struct SyntaxTree {
    pub tokens: Vec<Token>,
    pub items: Vec<Item>,
    pub diagnostics: Vec<XsDiagnostic>,
    pub brace_pairs: Vec<ByteRange>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Name {
    pub text: String,
    pub range: ByteRange,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TypeName {
    Int,
    Float,
    Bool,
    String,
    Vector,
    Void,
}

impl TypeName {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Int => "int",
            Self::Float => "float",
            Self::Bool => "bool",
            Self::String => "string",
            Self::Vector => "vector",
            Self::Void => "void",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TypeRef {
    Builtin(TypeName, ByteRange),
    Class(Name),
}

impl TypeRef {
    pub fn range(&self) -> ByteRange {
        match self {
            Self::Builtin(_, range) => *range,
            Self::Class(name) => name.range,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Modifiers {
    pub extern_: Option<ByteRange>,
    pub export: Option<ByteRange>,
    pub static_: Option<ByteRange>,
    pub const_: Option<ByteRange>,
    pub mutable: Option<ByteRange>,
}

impl Modifiers {
    pub fn is_empty(&self) -> bool {
        self.extern_.is_none()
            && self.export.is_none()
            && self.static_.is_none()
            && self.const_.is_none()
            && self.mutable.is_none()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    Include(Include),
    Variable(VarDecl),
    Function(FunctionDecl),
    Rule(RuleDecl),
    Class(ClassDecl),
    Pragma {
        kind: PragmaKind,
        value: Option<Expr>,
        range: ByteRange,
    },
    Error(ByteRange),
}

impl Item {
    pub fn range(&self) -> ByteRange {
        match self {
            Self::Include(item) => item.range,
            Self::Variable(item) => item.range,
            Self::Function(item) => item.range,
            Self::Rule(item) => item.range,
            Self::Class(item) => item.range,
            Self::Pragma { range, .. } | Self::Error(range) => *range,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Include {
    pub path: Option<String>,
    pub path_range: Option<ByteRange>,
    pub range: ByteRange,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VarDecl {
    pub modifiers: Modifiers,
    pub ty: TypeRef,
    pub name: Name,
    pub init: Option<Expr>,
    pub range: ByteRange,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Param {
    pub ty: TypeRef,
    pub name: Name,
    pub default: Option<Expr>,
    pub range: ByteRange,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FunctionDecl {
    pub modifiers: Modifiers,
    pub return_type: TypeRef,
    pub name: Name,
    pub params: Vec<Param>,
    pub params_range: ByteRange,
    pub body: Option<Block>,
    pub range: ByteRange,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuleModifierKind {
    Active,
    Inactive,
    Group,
    Priority,
    MinInterval,
    MaxInterval,
    HighFrequency,
    RunImmediately,
}

impl RuleModifierKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Inactive => "inactive",
            Self::Group => "group",
            Self::Priority => "priority",
            Self::MinInterval => "minInterval",
            Self::MaxInterval => "maxInterval",
            Self::HighFrequency => "highFrequency",
            Self::RunImmediately => "runImmediately",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RuleModifier {
    pub kind: RuleModifierKind,
    pub name: Option<Name>,
    pub value: Option<Expr>,
    pub range: ByteRange,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RuleDecl {
    pub name: Name,
    pub modifiers: Vec<RuleModifier>,
    pub body: Option<Block>,
    pub range: ByteRange,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClassDecl {
    pub name: Name,
    pub members: Vec<VarDecl>,
    pub range: ByteRange,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Block {
    pub stmts: Vec<Stmt>,
    pub range: ByteRange,
    pub closed: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PragmaKind {
    InfiniteLoopLimit,
    InfiniteRecursionLimit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AssignOp {
    Assign,
    Increment,
    Decrement,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompareOp {
    Less,
    LessEq,
    Greater,
    GreaterEq,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Case {
    pub label: Option<Expr>,
    pub label_range: ByteRange,
    pub body: Vec<Stmt>,
    pub range: ByteRange,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stmt {
    pub kind: StmtKind,
    pub range: ByteRange,
}

#[derive(Clone, Debug, PartialEq)]
pub enum StmtKind {
    Block(Block),
    Variable(VarDecl),
    Class(ClassDecl),
    Assign {
        target: Expr,
        op: AssignOp,
        value: Option<Expr>,
    },
    Expr(Expr),
    If {
        condition: Option<Expr>,
        then_branch: Option<Box<Stmt>>,
        else_branch: Option<Box<Stmt>>,
    },
    While {
        condition: Option<Expr>,
        body: Option<Box<Stmt>>,
    },
    For {
        variable: Option<Name>,
        start: Option<Expr>,
        compare: Option<CompareOp>,
        limit: Option<Expr>,
        body: Option<Box<Stmt>>,
    },
    Switch {
        scrutinee: Option<Expr>,
        cases: Vec<Case>,
    },
    Break,
    Continue,
    Return(Option<Expr>),
    Goto(Option<Name>),
    Label(Option<Name>),
    Dbg(Option<Name>),
    Breakpoint,
    Pragma {
        kind: PragmaKind,
        value: Option<Expr>,
    },
    Empty,
    Error,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Literal {
    Integer(i64),
    Float(f64),
    Bool(bool),
    String(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnaryOp {
    Negate,
    Plus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BinaryOp {
    Or,
    And,
    BitOr,
    BitAnd,
    Eq,
    NotEq,
    Less,
    LessEq,
    Greater,
    GreaterEq,
    Add,
    Sub,
    Mul,
    Div,
    Mod,
}

impl BinaryOp {
    pub const fn is_comparison(self) -> bool {
        matches!(
            self,
            Self::Eq | Self::NotEq | Self::Less | Self::LessEq | Self::Greater | Self::GreaterEq
        )
    }

    pub const fn is_logical(self) -> bool {
        matches!(self, Self::Or | Self::And)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Expr {
    pub kind: ExprKind,
    pub range: ByteRange,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ExprKind {
    Literal(Literal),
    Name(Name),
    Unary {
        op: UnaryOp,
        operand: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Call {
        callee: Name,
        args: Vec<Expr>,
        args_range: ByteRange,
        closed: bool,
        extra_commas: Vec<ByteRange>,
    },
    Cast {
        ty: TypeName,
        operand: Option<Box<Expr>>,
    },
    ParenthesizedType {
        ty: TypeName,
        type_range: ByteRange,
        operand: Option<Box<Expr>>,
    },
    Vector(Vec<Expr>),
    Member {
        object: Box<Expr>,
        member: Name,
    },
    Paren(Box<Expr>),
    Error,
}
