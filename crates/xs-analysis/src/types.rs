use xs_syntax::{TypeName, TypeRef};

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub enum Ty {
    Int,
    Float,
    Bool,
    String,
    Vector,
    Void,
    Class(String),
    Unknown,
}

impl Ty {
    pub fn from_name(name: TypeName) -> Self {
        match name {
            TypeName::Int => Self::Int,
            TypeName::Float => Self::Float,
            TypeName::Bool => Self::Bool,
            TypeName::String => Self::String,
            TypeName::Vector => Self::Vector,
            TypeName::Void => Self::Void,
        }
    }

    pub fn from_ref(reference: &TypeRef) -> Self {
        match reference {
            TypeRef::Builtin(name, _) => Self::from_name(*name),
            TypeRef::Class(name) => Self::Class(name.text.clone()),
        }
    }

    pub fn label(&self) -> &str {
        match self {
            Self::Int => "int",
            Self::Float => "float",
            Self::Bool => "bool",
            Self::String => "string",
            Self::Vector => "vector",
            Self::Void => "void",
            Self::Class(name) => name,
            Self::Unknown => "unknown",
        }
    }

    pub fn is_numeric_like(&self) -> bool {
        matches!(self, Self::Int | Self::Float | Self::Bool)
    }

    pub fn is_known(&self) -> bool {
        !matches!(self, Self::Unknown)
    }
}

pub fn incompatible(target: &Ty, source: &Ty) -> bool {
    if !target.is_known() || !source.is_known() {
        return false;
    }
    match target {
        Ty::Int | Ty::Float | Ty::Bool => !source.is_numeric_like(),
        Ty::String => matches!(source, Ty::Vector | Ty::Void | Ty::Class(_)),
        Ty::Vector => *source != Ty::Vector,
        Ty::Class(name) => !matches!(source, Ty::Class(other) if other == name),
        Ty::Void | Ty::Unknown => false,
    }
}
