use std::sync::Arc;

use xs_syntax::TypeName;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Int(i32),
    Float(f32),
    Bool(bool),
    Str(Arc<[u8]>),
    Vector([f32; 3]),
    Object(Box<Object>),
    Void,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Object {
    pub class: usize,
    pub members: Vec<Value>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ValueKind {
    Int,
    Float,
    Bool,
    Str,
    Vector,
    Object(usize),
    Void,
}

impl ValueKind {
    pub fn from_type_name(name: TypeName) -> Self {
        match name {
            TypeName::Int => Self::Int,
            TypeName::Float => Self::Float,
            TypeName::Bool => Self::Bool,
            TypeName::String => Self::Str,
            TypeName::Vector => Self::Vector,
            TypeName::Void => Self::Void,
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Int => "int",
            Self::Float => "float",
            Self::Bool => "bool",
            Self::Str => "string",
            Self::Vector => "vector",
            Self::Object(_) => "class",
            Self::Void => "void",
        }
    }
}

impl Value {
    pub fn text(text: &str) -> Self {
        Self::Str(Arc::from(text.as_bytes()))
    }

    pub fn bytes(bytes: &[u8]) -> Self {
        Self::Str(Arc::from(bytes))
    }

    pub fn kind(&self) -> ValueKind {
        match self {
            Self::Int(_) => ValueKind::Int,
            Self::Float(_) => ValueKind::Float,
            Self::Bool(_) => ValueKind::Bool,
            Self::Str(_) => ValueKind::Str,
            Self::Vector(_) => ValueKind::Vector,
            Self::Object(object) => ValueKind::Object(object.class),
            Self::Void => ValueKind::Void,
        }
    }

    pub fn is_number_like(&self) -> bool {
        matches!(self, Self::Int(_) | Self::Float(_) | Self::Bool(_))
    }

    pub fn as_f32(&self) -> Option<f32> {
        match self {
            Self::Int(value) => Some(*value as f32),
            Self::Float(value) => Some(*value),
            Self::Bool(value) => Some(if *value { 1.0 } else { 0.0 }),
            _ => None,
        }
    }

    pub fn as_bytes(&self) -> Option<&[u8]> {
        match self {
            Self::Str(bytes) => Some(bytes),
            _ => None,
        }
    }
}

pub fn zero_value(kind: ValueKind) -> Option<Value> {
    Some(match kind {
        ValueKind::Int => Value::Int(0),
        ValueKind::Float => Value::Float(0.0),
        ValueKind::Bool => Value::Bool(false),
        ValueKind::Str => Value::Str(Arc::from(&b""[..])),
        ValueKind::Vector => Value::Vector([0.0; 3]),
        ValueKind::Void => Value::Void,
        ValueKind::Object(_) => return None,
    })
}

pub fn float_to_int(value: f32) -> (i32, bool) {
    if value.is_nan() {
        return (0, true);
    }
    let truncated = value.trunc();
    let unusual = (value < 0.0 && truncated != value)
        || truncated < i32::MIN as f32
        || truncated >= 2_147_483_648.0;
    (value as i32, unusual)
}
