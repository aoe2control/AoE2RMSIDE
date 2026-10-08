use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

use serde_json::Value;

use crate::types::Ty;

const CATALOG_JSON: &str = include_str!("../data/xs-builtins-v1.json");
const SUPPORTED_MAJOR: u64 = 1;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum XsBuild {
    V4x,
    V5x,
}

impl XsBuild {
    pub const ALL: [Self; 2] = [Self::V4x, Self::V5x];

    pub const fn id(self) -> &'static str {
        match self {
            Self::V4x => "4x",
            Self::V5x => "5x",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "4x" => Some(Self::V4x),
            "5x" => Some(Self::V5x),
            _ => None,
        }
    }

    pub fn from_profile_id(profile_id: &str) -> Option<Self> {
        if profile_id.contains("101.103.54800") {
            Some(Self::V5x)
        } else if profile_id.contains("101.103.48987") {
            Some(Self::V4x)
        } else {
            None
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum XsRuntime {
    Rms,
    Trigger,
    Ai,
}

impl XsRuntime {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Rms => "rms",
            Self::Trigger => "trigger",
            Self::Ai => "ai",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Rms => "random map scripts",
            Self::Trigger => "scenario trigger scripts",
            Self::Ai => "AI scripts",
        }
    }

    fn from_id(id: &str) -> Option<Self> {
        match id {
            "rms" => Some(Self::Rms),
            "trigger" => Some(Self::Trigger),
            "ai" => Some(Self::Ai),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DocumentationBasis {
    RegisteredHelp,
    Signature,
    Unknown,
    Reference,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Documentation {
    pub text: String,
    pub basis: DocumentationBasis,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DocumentationSource {
    Aoe2DeUgcGuide,
}

#[derive(Clone, Debug, PartialEq)]
pub enum DefaultValue {
    Integer(i64),
    Bool(bool),
    String(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct BuiltinParam {
    pub name: String,
    pub ty: Ty,
    pub default: Option<DefaultValue>,
    pub documentation: Option<Documentation>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Builtin {
    pub name: String,
    pub category: String,
    pub builds: Vec<XsBuild>,
    pub runtimes: Vec<XsRuntime>,
    pub return_type: Ty,
    pub params: Vec<BuiltinParam>,
    pub parameter_names_known: bool,
    pub differences: Vec<(XsBuild, usize, Ty)>,
    pub successor: Option<(XsBuild, String)>,
    pub summary: String,
    pub basis: DocumentationBasis,
    pub return_documentation: Option<Documentation>,
    pub reference_source: Option<DocumentationSource>,
    pub related_identifiers: Vec<String>,
}

impl Builtin {
    pub fn has_documentation_metadata(&self) -> bool {
        self.reference_source.is_some()
            || self.return_documentation.is_some()
            || !self.related_identifiers.is_empty()
            || self
                .params
                .iter()
                .any(|param| param.documentation.is_some())
    }

    pub fn available_in(&self, build: XsBuild) -> bool {
        self.builds.contains(&build)
    }

    pub fn available_in_runtime(&self, runtime: XsRuntime) -> bool {
        self.runtimes.contains(&runtime)
    }

    pub fn params_for(&self, build: Option<XsBuild>) -> &[BuiltinParam] {
        let count = build
            .and_then(|build| {
                self.differences
                    .iter()
                    .find(|(candidate, _, _)| *candidate == build)
                    .map(|(_, count, _)| *count)
            })
            .unwrap_or(self.params.len());
        &self.params[..count.min(self.params.len())]
    }

    pub fn return_type_for(&self, build: Option<XsBuild>) -> Ty {
        build
            .and_then(|build| {
                self.differences
                    .iter()
                    .find(|(candidate, _, _)| *candidate == build)
                    .map(|(_, _, ty)| ty.clone())
            })
            .unwrap_or_else(|| self.return_type.clone())
    }

    pub fn signature(&self, build: Option<XsBuild>) -> String {
        let params = self
            .params_for(build)
            .iter()
            .map(BuiltinParam::label)
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "{} {}({params})",
            self.return_type_for(build).label(),
            self.name
        )
    }

    pub fn is_file_io(&self) -> bool {
        self.category == "file-io"
    }

    pub fn is_unsynchronized(&self) -> bool {
        self.name.starts_with("xsUnsync")
    }
}

impl BuiltinParam {
    pub fn label(&self) -> String {
        match &self.default {
            Some(DefaultValue::Integer(value)) => {
                format!("{} {} = {value}", self.ty.label(), self.name)
            }
            Some(DefaultValue::Bool(value)) => {
                format!("{} {} = {value}", self.ty.label(), self.name)
            }
            Some(DefaultValue::String(value)) => {
                format!("{} {} = \"{value}\"", self.ty.label(), self.name)
            }
            None => format!("{} {}", self.ty.label(), self.name),
        }
    }
}

#[derive(Debug)]
pub struct XsCatalog {
    pub catalog_id: String,
    builtins: Vec<Builtin>,
    by_name: BTreeMap<String, usize>,
}

impl XsCatalog {
    pub fn get(&self, name: &str) -> Option<&Builtin> {
        self.by_name.get(name).map(|index| &self.builtins[*index])
    }

    pub fn builtins(&self) -> &[Builtin] {
        &self.builtins
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let value: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
        let version = value
            .get("schemaVersion")
            .and_then(Value::as_str)
            .ok_or("XS catalog has no schemaVersion")?;
        let major = version
            .split('.')
            .next()
            .and_then(|major| major.parse::<u64>().ok())
            .ok_or("XS catalog schemaVersion is malformed")?;
        if major != SUPPORTED_MAJOR {
            return Err(format!("unsupported XS catalog major version {major}"));
        }
        let catalog_id = string(&value, "catalogId")?.to_owned();
        let entries = value
            .get("builtins")
            .and_then(Value::as_array)
            .ok_or("XS catalog has no builtins")?;
        if entries.is_empty() || entries.len() > 2048 {
            return Err("XS catalog builtins exceed the 1..2048 bound".to_owned());
        }
        let extended_docs = version
            .split('.')
            .nth(1)
            .and_then(|minor| minor.parse::<u64>().ok())
            .is_some_and(|minor| minor >= 1);
        let mut builtins = Vec::with_capacity(entries.len());
        let mut by_name = BTreeMap::new();
        for entry in entries {
            let builtin = parse_builtin(entry, extended_docs)?;
            if by_name
                .insert(builtin.name.clone(), builtins.len())
                .is_some()
            {
                return Err(format!("duplicate XS built-in {}", builtin.name));
            }
            builtins.push(builtin);
        }
        for builtin in &builtins {
            for related in &builtin.related_identifiers {
                if !by_name.contains_key(related)
                    && !matches!(
                        related.as_str(),
                        "cOriginVector"
                            | "cInvalidVector"
                            | "cPanelTop"
                            | "cPanelMiddle"
                            | "cPanelBottom"
                    )
                {
                    return Err(format!(
                        "{}: unknown related identifier {related}",
                        builtin.name
                    ));
                }
            }
            for build in [None, Some(XsBuild::V4x), Some(XsBuild::V5x)] {
                if build.is_none_or(|build| builtin.available_in(build))
                    && !crate::documentation::within_rendered_limit(builtin, build)
                {
                    return Err(format!(
                        "{}: rendered documentation exceeds 16 KiB",
                        builtin.name
                    ));
                }
            }
        }
        Ok(Self {
            catalog_id,
            builtins,
            by_name,
        })
    }
}

pub fn catalog() -> Result<&'static XsCatalog, String> {
    static CATALOG: OnceLock<Result<XsCatalog, String>> = OnceLock::new();
    CATALOG
        .get_or_init(|| XsCatalog::parse(CATALOG_JSON))
        .as_ref()
        .map_err(Clone::clone)
}

fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("XS catalog field {field} is missing"))
}

fn value_type(name: &str) -> Result<Ty, String> {
    Ok(match name {
        "void" => Ty::Void,
        "int" => Ty::Int,
        "float" => Ty::Float,
        "bool" => Ty::Bool,
        "string" => Ty::String,
        "vector" => Ty::Vector,
        other => return Err(format!("unknown XS catalog type {other}")),
    })
}

fn parse_builtin(entry: &Value, extended_docs: bool) -> Result<Builtin, String> {
    let name = identifier(string(entry, "name")?)?.to_owned();
    let list = |field: &str| -> Result<Vec<&str>, String> {
        entry
            .get(field)
            .and_then(Value::as_array)
            .ok_or_else(|| format!("{name}: {field} is missing"))?
            .iter()
            .map(|item| {
                item.as_str()
                    .ok_or_else(|| format!("{name}: {field} has a non-string item"))
            })
            .collect()
    };
    let builds = list("builds")?
        .into_iter()
        .map(|id| XsBuild::from_id(id).ok_or_else(|| format!("{name}: unknown build {id}")))
        .collect::<Result<Vec<_>, _>>()?;
    let runtimes = list("runtimes")?
        .into_iter()
        .map(|id| XsRuntime::from_id(id).ok_or_else(|| format!("{name}: unknown runtime {id}")))
        .collect::<Result<Vec<_>, _>>()?;
    let raw_params = entry
        .get("parameters")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{name}: parameters are missing"))?;
    if raw_params.len() > 16 {
        return Err(format!("{name}: too many parameters"));
    }
    let params = raw_params
        .iter()
        .map(|param| {
            let ty = value_type(string(param, "type")?)?;
            let default = match param.get("default") {
                None => None,
                Some(Value::Bool(value)) => Some(DefaultValue::Bool(*value)),
                Some(Value::Number(number)) => {
                    Some(DefaultValue::Integer(number.as_i64().ok_or_else(|| {
                        format!("{name}: default is not an integer")
                    })?))
                }
                Some(Value::String(value)) if value.chars().count() <= 64 => {
                    Some(DefaultValue::String(value.clone()))
                }
                Some(_) => return Err(format!("{name}: unsupported default")),
            };
            Ok(BuiltinParam {
                name: identifier(string(param, "name")?)?.to_owned(),
                ty,
                default,
                documentation: parse_documentation(param.get("documentation"), extended_docs)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let differences = entry
        .get("buildDifferences")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    let build = XsBuild::from_id(string(item, "build")?)
                        .ok_or_else(|| format!("{name}: unknown difference build"))?;
                    let count = item
                        .get("parameterCount")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| format!("{name}: parameterCount is missing"))?
                        as usize;
                    if count > params.len() {
                        return Err(format!("{name}: parameterCount exceeds the parameters"));
                    }
                    Ok((build, count, value_type(string(item, "returnType")?)?))
                })
                .collect::<Result<Vec<_>, String>>()
        })
        .transpose()?
        .unwrap_or_default();
    let successor = entry
        .get("successor")
        .map(|item| -> Result<_, String> {
            let build = XsBuild::from_id(string(item, "build")?)
                .ok_or_else(|| format!("{name}: unknown successor build"))?;
            Ok((build, string(item, "name")?.to_owned()))
        })
        .transpose()?;
    let basis = parse_basis(string(entry, "basis")?, extended_docs)?;
    let return_documentation =
        parse_documentation(entry.get("returnDocumentation"), extended_docs)?;
    let reference_source = match entry.get("referenceSource") {
        Some(Value::String(source)) if extended_docs && source == "aoe2de-ugc-guide" => {
            Some(DocumentationSource::Aoe2DeUgcGuide)
        }
        None => None,
        Some(_) => return Err(format!("{name}: invalid documentation reference source")),
    };
    let has_reference = basis == DocumentationBasis::Reference
        || return_documentation
            .as_ref()
            .is_some_and(|doc| doc.basis == DocumentationBasis::Reference)
        || params.iter().any(|param| {
            param
                .documentation
                .as_ref()
                .is_some_and(|doc| doc.basis == DocumentationBasis::Reference)
        });
    if has_reference != reference_source.is_some() {
        return Err(format!(
            "{name}: reference documentation/source must be paired"
        ));
    }
    let related_identifiers = match entry.get("relatedIdentifiers") {
        None => Vec::new(),
        Some(Value::Array(values)) if extended_docs && !values.is_empty() && values.len() <= 12 => {
            let names = values
                .iter()
                .map(|value| {
                    identifier(
                        value
                            .as_str()
                            .ok_or("related identifier must be a string")?,
                    )
                    .map(str::to_owned)
                })
                .collect::<Result<Vec<_>, _>>()?;
            if names.iter().collect::<BTreeSet<_>>().len() != names.len() {
                return Err(format!("{name}: duplicate related identifier"));
            }
            names
        }
        Some(_) => return Err(format!("{name}: invalid related identifiers")),
    };
    let summary = bounded_text(string(entry, "summary")?, 240)?.to_owned();
    Ok(Builtin {
        category: string(entry, "category")?.to_owned(),
        builds,
        runtimes,
        return_type: value_type(string(entry, "returnType")?)?,
        params,
        parameter_names_known: entry.get("parameterNamesKnown") != Some(&Value::Bool(false)),
        differences,
        successor,
        summary,
        basis,
        return_documentation,
        reference_source,
        related_identifiers,
        name,
    })
}

fn identifier(value: &str) -> Result<&str, String> {
    let mut bytes = value.bytes();
    if value.len() > 64
        || !bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        || !bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Err("invalid XS catalog identifier".to_owned());
    }
    Ok(value)
}

fn bounded_text(value: &str, maximum: usize) -> Result<&str, String> {
    if value.is_empty() || value.chars().count() > maximum {
        return Err(format!(
            "XS documentation text exceeds 1..{maximum} scalar values"
        ));
    }
    Ok(value)
}

fn parse_basis(value: &str, extended: bool) -> Result<DocumentationBasis, String> {
    match value {
        "help" => Ok(DocumentationBasis::RegisteredHelp),
        "signature" => Ok(DocumentationBasis::Signature),
        "unknown" => Ok(DocumentationBasis::Unknown),
        "reference" if extended => Ok(DocumentationBasis::Reference),
        _ => Err(format!("unknown XS documentation basis {value}")),
    }
}

fn parse_documentation(
    value: Option<&Value>,
    extended: bool,
) -> Result<Option<Documentation>, String> {
    let Some(value) = value else { return Ok(None) };
    if !extended {
        return Err("documentation fields require catalog 1.1".to_owned());
    }
    let object = value.as_object().ok_or("documentation must be an object")?;
    if object.len() != 2 || !object.contains_key("text") || !object.contains_key("basis") {
        return Err("documentation contains unsupported fields".to_owned());
    }
    Ok(Some(Documentation {
        text: bounded_text(string(value, "text")?, 800)?.to_owned(),
        basis: parse_basis(string(value, "basis")?, extended)?,
    }))
}
