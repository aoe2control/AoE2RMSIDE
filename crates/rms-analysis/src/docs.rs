use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;

pub const DOCUMENTATION_CATALOG_JSON: &str = include_str!("../data/rms-documentation-v1.json");
const SUPPORTED_MAJOR: u64 = 1;
const SCHEMA_ID: &str = "https://rmside.invalid/schemas/rms-documentation-catalog/v1";

pub const SECTIONS: [&str; 7] = [
    "player_setup",
    "land_generation",
    "elevation_generation",
    "cliff_generation",
    "terrain_generation",
    "connection_generation",
    "objects_generation",
];

const MAXIMUM_SUMMARY: usize = 240;
const MAXIMUM_PARAGRAPH: usize = 900;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "kebab-case")]
pub enum TermKind {
    Section,
    Directive,
    Control,
    Command,
    Attribute,
    Function,
    Delimiter,
}

impl TermKind {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Section => "Section",
            Self::Directive => "Directive",
            Self::Control => "Control",
            Self::Command => "Command",
            Self::Attribute => "Attribute",
            Self::Function => "Value form",
            Self::Delimiter => "Delimiter",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ValueKind {
    Number,
    Object,
    Terrain,
    Constant,
    Label,
    Name,
    File,
}

impl ValueKind {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Number => "number",
            Self::Object => "object",
            Self::Terrain => "terrain",
            Self::Constant => "constant",
            Self::Label => "label",
            Self::Name => "name",
            Self::File => "file",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceStatus {
    EngineVerified,
    Documented,
    Uncertain,
}

impl EvidenceStatus {
    pub const fn label(self) -> &'static str {
        match self {
            Self::EngineVerified => "engine-verified",
            Self::Documented => "documented",
            Self::Uncertain => "uncertain",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Evidence {
    pub status: EvidenceStatus,
    pub sources: Vec<String>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Parameter {
    pub name: String,
    pub kind: ValueKind,
    #[serde(default)]
    pub optional: bool,
    pub description: String,
    #[serde(default)]
    pub range: Option<String>,
    #[serde(default)]
    pub default: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Usage {
    #[serde(rename = "where")]
    pub places: Vec<String>,
    pub summary: String,
    #[serde(default)]
    pub details: Vec<String>,
    #[serde(default)]
    pub parameters: Option<Vec<Parameter>>,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub example: Vec<String>,
    #[serde(default)]
    pub evidence: Option<Evidence>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileNote {
    pub profiles: Vec<String>,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Term {
    pub name: String,
    pub kind: TermKind,
    pub summary: String,
    #[serde(default)]
    pub details: Vec<String>,
    #[serde(default)]
    pub parameters: Vec<Parameter>,
    #[serde(default)]
    pub opens_block: bool,
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub example: Vec<String>,
    #[serde(default)]
    pub related: Vec<String>,
    #[serde(default)]
    pub usages: Vec<Usage>,
    #[serde(default)]
    pub profile_notes: Vec<ProfileNote>,
    pub evidence: Evidence,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Membership {
    #[serde(default)]
    pub prefixes: Vec<String>,
    #[serde(default)]
    pub suffixes: Vec<String>,
    #[serde(default)]
    pub names: Vec<String>,
    #[serde(default)]
    pub patterns: Vec<String>,
    #[serde(default)]
    pub remainder: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Family {
    pub id: String,
    pub title: String,
    pub source: FamilySource,
    pub summary: String,
    #[serde(default)]
    pub details: Vec<String>,
    #[serde(default)]
    pub used_by: Vec<String>,
    pub membership: Membership,
    #[serde(default)]
    pub members: BTreeMap<String, String>,
    #[serde(default)]
    pub example: Vec<String>,
    pub evidence: Evidence,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum FamilySource {
    Definitions,
    RunSettings,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snippet {
    pub id: String,
    pub label: String,
    pub prefix: String,
    #[serde(rename = "where")]
    pub places: Vec<String>,
    pub summary: String,
    pub body: Vec<String>,
}

impl Snippet {
    pub fn insert_text(&self) -> String {
        self.body.join("\n")
    }

    pub fn offered(&self, section: &str, top_level: bool) -> bool {
        self.places
            .iter()
            .any(|place| place == "*" || (top_level && place == section))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceGap {
    pub term: String,
    pub reason: String,
    pub reviewed: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub id: String,
    pub title: String,
    pub role: SourceRole,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum SourceRole {
    Primary,
    Research,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCatalog {
    #[serde(rename = "$schema")]
    schema: String,
    schema_version: String,
    compatibility: Compatibility,
    catalog_id: String,
    profiles: Vec<String>,
    sources: Vec<Source>,
    terms: Vec<Term>,
    families: Vec<Family>,
    snippets: Vec<Snippet>,
    evidence_gaps: Vec<EvidenceGap>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Compatibility {
    minimum_major: u64,
    maximum_major: u64,
}

#[derive(Debug)]
pub struct DocumentationCatalog {
    pub catalog_id: String,
    pub schema_version: String,
    pub profiles: Vec<String>,
    pub sources: Vec<Source>,
    terms: Vec<Term>,
    by_name: BTreeMap<String, usize>,
    pub families: Vec<Family>,
    pub snippets: Vec<Snippet>,
    pub evidence_gaps: Vec<EvidenceGap>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DocContext<'a> {
    pub section: Option<&'a str>,
    pub opener: Option<&'a str>,
    pub profile: Option<&'a str>,
}

impl DocContext<'_> {
    fn keys(&self) -> Vec<String> {
        let section = self.section.filter(|section| !section.is_empty());
        match (section, self.opener) {
            (Some(section), Some(opener)) => vec![format!("{section}/{opener}")],
            (Some(section), None) => vec![section.to_owned()],
            (None, Some(opener)) => vec![format!("/{opener}")],
            (None, None) => Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Signature {
    pub label: String,
    pub parameters: Vec<SignatureParameter>,
    pub documentation: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SignatureParameter {
    pub range: (u32, u32),
    pub documentation: String,
}

impl Term {
    pub fn usage_for(&self, context: &DocContext<'_>) -> Option<&Usage> {
        let keys = context.keys();
        if let Some(usage) = self.usages.iter().find(|usage| {
            usage.places.iter().any(|place| {
                keys.iter().any(|key| {
                    if let Some(opener) = key.strip_prefix('/') {
                        place
                            .rsplit_once('/')
                            .is_some_and(|(_, candidate)| candidate == opener)
                    } else {
                        place == key
                    }
                })
            })
        }) {
            return Some(usage);
        }
        if let Some(usage) = self
            .usages
            .iter()
            .find(|usage| usage.places.iter().any(|place| place == "*"))
        {
            return Some(usage);
        }
        (self.usages.len() == 1).then(|| &self.usages[0])
    }

    pub fn parameters_in<'a>(&'a self, usage: Option<&'a Usage>) -> &'a [Parameter] {
        usage
            .and_then(|usage| usage.parameters.as_deref())
            .unwrap_or(&self.parameters)
    }

    pub fn signature_label(&self, usage: Option<&Usage>) -> (String, Vec<(u32, u32)>) {
        let mut label = self.name.clone();
        let mut ranges = Vec::new();
        if self.kind == TermKind::Function {
            label.push('(');
            for (index, parameter) in self.parameters_in(usage).iter().enumerate() {
                if index > 0 {
                    label.push_str(", ");
                }
                let start = utf16_len(&label);
                label.push_str(&parameter.name);
                ranges.push((start, utf16_len(&label)));
            }
            label.push(')');
            return (label, ranges);
        }
        for parameter in self.parameters_in(usage) {
            label.push(' ');
            if parameter.optional {
                label.push('[');
            }
            let start = utf16_len(&label);
            label.push_str(&parameter.name);
            ranges.push((start, utf16_len(&label)));
            if parameter.optional {
                label.push(']');
            }
        }
        if self.opens_block {
            label.push_str(" { … }");
        }
        (label, ranges)
    }

    pub fn signature(&self, context: &DocContext<'_>) -> Signature {
        let usage = self.usage_for(context);
        let (label, ranges) = self.signature_label(usage);
        let parameters = self
            .parameters_in(usage)
            .iter()
            .zip(ranges)
            .map(|(parameter, range)| SignatureParameter {
                range,
                documentation: parameter_markdown(parameter),
            })
            .collect();
        Signature {
            label,
            parameters,
            documentation: usage
                .map_or_else(|| self.summary.clone(), |usage| usage.summary.clone()),
        }
    }

    fn notes_for<'a>(&'a self, profile: Option<&'a str>) -> impl Iterator<Item = &'a str> + 'a {
        self.profile_notes
            .iter()
            .filter(move |note| {
                profile.is_some_and(|profile| note.profiles.iter().any(|p| p == profile))
            })
            .map(|note| note.text.as_str())
    }
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

fn section_header(section: &str) -> String {
    format!("<{}>", section.to_ascii_uppercase())
}

fn place_label(place: &str) -> String {
    if place == "*" {
        return "anywhere".to_owned();
    }
    match place.split_once('/') {
        Some((section, opener)) => {
            format!("inside `{opener}` in `{}`", section_header(section))
        }
        None => format!("in `{}`, outside blocks", section_header(place)),
    }
}

fn places_label(places: &[String]) -> String {
    let mut grouped = BTreeMap::<&str, Vec<&str>>::new();
    let mut order = Vec::new();
    let mut plain = Vec::new();
    for place in places {
        match place.split_once('/') {
            Some((section, opener)) => {
                if !grouped.contains_key(section) {
                    order.push(section);
                }
                grouped.entry(section).or_default().push(opener);
            }
            None => plain.push(place_label(place)),
        }
    }
    let mut parts = Vec::new();
    for section in order {
        let openers = &grouped[section];
        let blocks = if openers.len() > 2
            && openers
                .iter()
                .all(|opener| opener.starts_with("create_connect_"))
        {
            "the `create_connect_…` blocks".to_owned()
        } else {
            join_words(
                &openers
                    .iter()
                    .map(|opener| format!("`{opener}`"))
                    .collect::<Vec<_>>(),
            )
        };
        parts.push(format!("inside {blocks} in `{}`", section_header(section)));
    }
    parts.extend(plain);
    join_words(&parts)
}

fn join_words(parts: &[String]) -> String {
    match parts {
        [] => String::new(),
        [one] => one.clone(),
        [first, second] => format!("{first} and {second}"),
        [rest @ .., last] => format!("{}, and {last}", rest.join(", ")),
    }
}

pub fn parameter_markdown(parameter: &Parameter) -> String {
    let mut text = format!("`{}` ({}", parameter.name, parameter.kind.label());
    if parameter.optional {
        text.push_str(", optional");
    }
    text.push_str(") — ");
    text.push_str(&parameter.description);
    if let Some(range) = &parameter.range {
        let _ = write!(text, " Range: {range}.");
    }
    if let Some(default) = &parameter.default {
        let _ = write!(text, " Default: {default}.");
    }
    text
}

fn code_block(lines: &[String]) -> String {
    format!("```rms\n{}\n```", lines.join("\n"))
}

pub fn term_markdown(
    catalog: &DocumentationCatalog,
    term: &Term,
    context: &DocContext<'_>,
) -> String {
    let usage = term.usage_for(context);
    let (label, _) = term.signature_label(usage);
    let mut sections = vec![code_block(&[label])];
    let summary = usage.map_or(term.summary.as_str(), |usage| usage.summary.as_str());
    sections.push(summary.to_owned());
    match usage {
        Some(usage) if !usage.places.iter().any(|place| place == "*") => sections.push(format!(
            "*{} {}.*",
            term.kind.label(),
            places_label(&usage.places)
        )),
        Some(_) => {}
        None if !term.usages.is_empty() => {
            let mut list = String::from("**Where it applies**");
            for usage in &term.usages {
                let _ = write!(
                    list,
                    "\n- {}: {}",
                    capitalize(&places_label(&usage.places)),
                    usage.summary
                );
            }
            sections.push(list);
        }
        None => {}
    }
    let parameters = term.parameters_in(usage);
    if !parameters.is_empty() {
        let mut list = String::from("**Parameters**");
        for parameter in parameters {
            let _ = write!(list, "\n- {}", parameter_markdown(parameter));
        }
        sections.push(list);
    }
    let details = usage.map_or(&term.details, |usage| {
        if usage.details.is_empty() {
            &term.details
        } else {
            &usage.details
        }
    });
    sections.extend(details.iter().cloned());
    sections.extend(term.notes_for(context.profile).map(str::to_owned));
    let default = usage
        .and_then(|usage| usage.default.as_ref())
        .or(term.default.as_ref());
    if let Some(default) = default {
        sections.push(format!("**When omitted:** {default}"));
    }
    let example = usage
        .map(|usage| &usage.example)
        .filter(|example| !example.is_empty())
        .unwrap_or(&term.example);
    if !example.is_empty() {
        sections.push(format!("**Example**\n\n{}", code_block(example)));
    }
    let related = term
        .related
        .iter()
        .map(|name| match catalog.family(name) {
            Some(family) => family.title.clone(),
            None => format!("`{name}`"),
        })
        .collect::<Vec<_>>();
    if !related.is_empty() {
        sections.push(format!("**See also:** {}", related.join(", ")));
    }
    sections.join("\n\n")
}

fn capitalize(text: &str) -> String {
    let mut characters = text.chars();
    match characters.next() {
        Some(first) => first.to_uppercase().chain(characters).collect(),
        None => String::new(),
    }
}

pub fn constant_markdown(family: Option<&Family>, name: &str, value: Option<&str>) -> String {
    let mut sections = vec![code_block(&[name.to_owned()])];
    let source = family.map_or(FamilySource::Definitions, |family| family.source);
    sections.push(match (source, value) {
        (FamilySource::RunSettings, _) => "Label defined by the run settings.".to_owned(),
        (FamilySource::Definitions, Some(value)) => format!("Built-in constant, value `{value}`."),
        (FamilySource::Definitions, None) => "Built-in constant.".to_owned(),
    });
    if let Some(family) = family {
        if let Some(note) = family.member_note(name) {
            sections.push(note.to_owned());
        }
        sections.push(format!("**{}** — {}", family.title, family.summary));
        if !family.used_by.is_empty() {
            let users = family
                .used_by
                .iter()
                .map(|name| format!("`{name}`"))
                .collect::<Vec<_>>();
            sections.push(format!("**Used by:** {}", users.join(", ")));
        }
    }
    sections.join("\n\n")
}

pub fn snippet_markdown(snippet: &Snippet) -> String {
    let preview = snippet
        .body
        .iter()
        .map(|line| {
            strip_placeholders(&line.replace('\t', "    "))
                .trim_end()
                .to_owned()
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    format!("{}\n\n{}", snippet.summary, code_block(&preview))
}

pub fn strip_placeholders(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'$' {
            if bytes.get(index + 1) == Some(&b'{') {
                let rest = &text[index + 2..];
                if let Some(colon) = rest.find(':')
                    && rest[..colon].bytes().all(|byte| byte.is_ascii_digit())
                    && let Some(end) = rest[colon..].find('}')
                {
                    output.push_str(&rest[colon + 1..colon + end]);
                    index += 2 + colon + end + 1;
                    continue;
                }
            } else {
                let digits = bytes[index + 1..]
                    .iter()
                    .take_while(|byte| byte.is_ascii_digit())
                    .count();
                if digits > 0 {
                    index += 1 + digits;
                    continue;
                }
            }
        }
        let character = text[index..].chars().next().unwrap_or_default();
        output.push(character);
        index += character.len_utf8().max(1);
    }
    output
}

pub fn tab_stops(text: &str) -> Vec<u32> {
    let bytes = text.as_bytes();
    let mut stops = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'$' {
            let start = index + 1 + usize::from(bytes.get(index + 1) == Some(&b'{'));
            let digits = bytes[start..]
                .iter()
                .take_while(|byte| byte.is_ascii_digit())
                .count();
            if digits > 0
                && let Ok(stop) = text[start..start + digits].parse()
            {
                stops.push(stop);
            }
        }
        index += 1;
    }
    stops
}

impl Family {
    pub fn member_note(&self, name: &str) -> Option<&str> {
        self.members.get(name).map(String::as_str).or_else(|| {
            self.members
                .iter()
                .find(|(pattern, _)| pattern.contains('#') && matches_pattern(pattern, name))
                .map(|(_, note)| note.as_str())
        })
    }
}

impl DocumentationCatalog {
    pub fn term(&self, name: &str) -> Option<&Term> {
        self.by_name.get(name).map(|index| &self.terms[*index])
    }

    pub fn terms(&self) -> &[Term] {
        &self.terms
    }

    pub fn family(&self, id: &str) -> Option<&Family> {
        self.families.iter().find(|family| family.id == id)
    }

    pub fn snippet(&self, id: &str) -> Option<&Snippet> {
        self.snippets.iter().find(|snippet| snippet.id == id)
    }

    pub fn definition_family(&self, name: &str) -> Option<&Family> {
        let definitions = self
            .families
            .iter()
            .filter(|family| family.source == FamilySource::Definitions);
        definitions
            .clone()
            .find(|family| claims(&family.membership, name))
            .or_else(|| {
                definitions
                    .clone()
                    .find(|family| family.membership.remainder)
            })
    }

    pub fn run_setting_family(&self, name: &str) -> Option<&Family> {
        self.families.iter().find(|family| {
            family.source == FamilySource::RunSettings
                && (family.members.contains_key(name) || claims(&family.membership, name))
        })
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let value: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
        let version = value
            .get("schemaVersion")
            .and_then(Value::as_str)
            .ok_or("documentation catalog has no schemaVersion")?;
        let major = version
            .split('.')
            .next()
            .and_then(|major| major.parse::<u64>().ok())
            .ok_or("documentation catalog schemaVersion is malformed")?;
        if major != SUPPORTED_MAJOR {
            return Err(format!(
                "unsupported documentation catalog major version {major}"
            ));
        }
        let raw: RawCatalog = serde_json::from_value(value).map_err(|error| error.to_string())?;
        if raw.schema != SCHEMA_ID {
            return Err(format!(
                "unexpected documentation catalog schema {}",
                raw.schema
            ));
        }
        if raw.compatibility.minimum_major > SUPPORTED_MAJOR
            || raw.compatibility.maximum_major < SUPPORTED_MAJOR
        {
            return Err("documentation catalog compatibility excludes this reader".to_owned());
        }
        validate(&raw)?;
        let by_name = raw
            .terms
            .iter()
            .enumerate()
            .map(|(index, term)| (term.name.clone(), index))
            .collect();
        Ok(Self {
            catalog_id: raw.catalog_id,
            schema_version: raw.schema_version,
            profiles: raw.profiles,
            sources: raw.sources,
            terms: raw.terms,
            by_name,
            families: raw.families,
            snippets: raw.snippets,
            evidence_gaps: raw.evidence_gaps,
        })
    }
}

fn claims(membership: &Membership, name: &str) -> bool {
    membership.names.iter().any(|candidate| candidate == name)
        || membership
            .prefixes
            .iter()
            .any(|prefix| name.starts_with(prefix.as_str()))
        || membership
            .suffixes
            .iter()
            .any(|suffix| name.ends_with(suffix.as_str()))
        || membership
            .patterns
            .iter()
            .any(|pattern| matches_pattern(pattern, name))
}

fn matches_pattern(pattern: &str, name: &str) -> bool {
    let mut parts = pattern.split('#');
    let Some(first) = parts.next() else {
        return false;
    };
    let Some(mut rest) = name.strip_prefix(first) else {
        return false;
    };
    let mut wildcards = 0;
    for part in parts {
        wildcards += 1;
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        let Some(after) = rest[digits..].strip_prefix(part) else {
            return false;
        };
        rest = after;
    }
    if wildcards == 0 {
        return pattern == name;
    }
    rest.is_empty()
}

fn check_text(owner: &str, field: &str, text: &str, maximum: usize) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err(format!("{owner}: {field} is empty"));
    }
    if text.len() > maximum {
        return Err(format!("{owner}: {field} is longer than {maximum} bytes"));
    }
    Ok(())
}

fn check_evidence(
    owner: &str,
    evidence: &Evidence,
    sources: &BTreeSet<&str>,
) -> Result<(), String> {
    if evidence.sources.is_empty() {
        return Err(format!("{owner}: evidence names no source"));
    }
    for source in &evidence.sources {
        if !sources.contains(source.as_str()) {
            return Err(format!("{owner}: unknown evidence source {source}"));
        }
    }
    Ok(())
}

fn check_parameters(owner: &str, parameters: &[Parameter]) -> Result<(), String> {
    let mut optional_seen = false;
    for parameter in parameters {
        if parameter.name.is_empty()
            || !parameter
                .name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
        {
            return Err(format!(
                "{owner}: malformed parameter name {}",
                parameter.name
            ));
        }
        check_text(
            owner,
            "parameter description",
            &parameter.description,
            MAXIMUM_PARAGRAPH,
        )?;
        if optional_seen && !parameter.optional {
            return Err(format!(
                "{owner}: a required parameter follows an optional one"
            ));
        }
        optional_seen |= parameter.optional;
    }
    Ok(())
}

fn check_place(owner: &str, place: &str) -> Result<(), String> {
    if place == "*" {
        return Ok(());
    }
    let (section, opener) = match place.split_once('/') {
        Some((section, opener)) => (section, Some(opener)),
        None => (place, None),
    };
    if !SECTIONS.contains(&section) {
        return Err(format!("{owner}: unknown section in context {place}"));
    }
    if let Some(opener) = opener
        && !rms_semantics::opens_descriptor_block(opener)
    {
        return Err(format!("{owner}: {opener} does not open a block"));
    }
    Ok(())
}

fn validate(raw: &RawCatalog) -> Result<(), String> {
    if !raw
        .catalog_id
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return Err("malformed catalogId".to_owned());
    }
    if raw.profiles.is_empty() {
        return Err("documentation catalog lists no profiles".to_owned());
    }
    let profiles = raw
        .profiles
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let mut sources = BTreeSet::new();
    for source in &raw.sources {
        if !sources.insert(source.id.as_str()) {
            return Err(format!("duplicate source {}", source.id));
        }
    }
    let mut names = BTreeSet::new();
    for term in &raw.terms {
        if !names.insert(term.name.as_str()) {
            return Err(format!("duplicate term {}", term.name));
        }
    }
    let mut families = BTreeSet::new();
    let mut remainders = 0;
    for family in &raw.families {
        if !families.insert(family.id.as_str()) || names.contains(family.id.as_str()) {
            return Err(format!("duplicate family {}", family.id));
        }
        let owner = format!("family {}", family.id);
        check_text(&owner, "title", &family.title, 80)?;
        check_text(&owner, "summary", &family.summary, MAXIMUM_SUMMARY)?;
        for paragraph in &family.details {
            check_text(&owner, "details", paragraph, MAXIMUM_PARAGRAPH)?;
        }
        for (member, note) in &family.members {
            check_text(&owner, member, note, MAXIMUM_SUMMARY)?;
        }
        for user in &family.used_by {
            if !names.contains(user.as_str()) {
                return Err(format!("{owner}: unknown user {user}"));
            }
        }
        for pattern in &family.membership.patterns {
            let mut parts = pattern.split('#');
            parts.next();
            let mut wildcards = 0;
            for part in parts {
                wildcards += 1;
                if part.starts_with(|character: char| character.is_ascii_digit()) {
                    return Err(format!("{owner}: pattern {pattern} has a digit after #"));
                }
            }
            if wildcards == 0 {
                return Err(format!("{owner}: pattern {pattern} has no #"));
            }
        }
        if family.membership.remainder {
            remainders += 1;
            if family.source != FamilySource::Definitions {
                return Err(format!(
                    "{owner}: only a definitions family can be the remainder"
                ));
            }
        }
        check_evidence(&owner, &family.evidence, &sources)?;
    }
    if remainders > 1 {
        return Err("more than one remainder family".to_owned());
    }
    for term in &raw.terms {
        let owner = format!("term {}", term.name);
        check_text(&owner, "summary", &term.summary, MAXIMUM_SUMMARY)?;
        for paragraph in &term.details {
            check_text(&owner, "details", paragraph, MAXIMUM_PARAGRAPH)?;
        }
        check_parameters(&owner, &term.parameters)?;
        check_evidence(&owner, &term.evidence, &sources)?;
        for related in &term.related {
            if related == &term.name {
                return Err(format!("{owner}: relates to itself"));
            }
            if !names.contains(related.as_str()) && !families.contains(related.as_str()) {
                return Err(format!("{owner}: unknown related term {related}"));
            }
        }
        let mut places = BTreeSet::new();
        for usage in &term.usages {
            if usage.places.is_empty() {
                return Err(format!("{owner}: a usage has no context"));
            }
            for place in &usage.places {
                check_place(&owner, place)?;
                if !places.insert(place.as_str()) {
                    return Err(format!("{owner}: context {place} is documented twice"));
                }
            }
            check_text(&owner, "usage summary", &usage.summary, MAXIMUM_SUMMARY)?;
            for paragraph in &usage.details {
                check_text(&owner, "usage details", paragraph, MAXIMUM_PARAGRAPH)?;
            }
            if let Some(parameters) = &usage.parameters {
                check_parameters(&owner, parameters)?;
            }
            if let Some(evidence) = &usage.evidence {
                check_evidence(&owner, evidence, &sources)?;
            }
        }
        for note in &term.profile_notes {
            check_text(&owner, "profile note", &note.text, MAXIMUM_PARAGRAPH)?;
            if note.profiles.is_empty() {
                return Err(format!("{owner}: a profile note names no profile"));
            }
            for profile in &note.profiles {
                if !profiles.contains(profile.as_str()) {
                    return Err(format!("{owner}: unknown profile {profile}"));
                }
            }
        }
    }
    let mut snippets = BTreeSet::new();
    for snippet in &raw.snippets {
        let owner = format!("snippet {}", snippet.id);
        if !snippets.insert(snippet.id.as_str()) {
            return Err(format!("duplicate snippet {}", snippet.id));
        }
        check_text(&owner, "summary", &snippet.summary, MAXIMUM_SUMMARY)?;
        if snippet.body.is_empty() || snippet.prefix.is_empty() || snippet.label.is_empty() {
            return Err(format!("{owner}: label, prefix, and body are required"));
        }
        for place in &snippet.places {
            if place != "*" && !SECTIONS.contains(&place.as_str()) {
                return Err(format!("{owner}: unknown section {place}"));
            }
        }
        let stops = tab_stops(&snippet.insert_text());
        let mut first_seen = Vec::new();
        for stop in stops.iter().copied().filter(|stop| *stop > 0) {
            if !first_seen.contains(&stop) {
                first_seen.push(stop);
            }
        }
        if first_seen
            .iter()
            .enumerate()
            .any(|(index, stop)| *stop as usize != index + 1)
        {
            return Err(format!(
                "{owner}: tab stops are not numbered 1, 2, … in text order"
            ));
        }
        if stops.iter().filter(|stop| **stop == 0).count() != 1 || stops.last() != Some(&0) {
            return Err(format!("{owner}: the final caret $0 must come last, once"));
        }
    }
    for gap in &raw.evidence_gaps {
        if names.contains(gap.term.as_str()) {
            return Err(format!("evidence gap {} names a documented term", gap.term));
        }
        check_text(&gap.term, "reason", &gap.reason, MAXIMUM_PARAGRAPH)?;
    }
    Ok(())
}

pub fn documentation_catalog() -> Result<&'static DocumentationCatalog, String> {
    static CATALOG: OnceLock<Result<DocumentationCatalog, String>> = OnceLock::new();
    CATALOG
        .get_or_init(|| DocumentationCatalog::parse(DOCUMENTATION_CATALOG_JSON))
        .as_ref()
        .map_err(Clone::clone)
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum InventoryClass {
    Section,
    Control,
    Command,
    Attribute,
    Function,
}

impl InventoryClass {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Section => "sections",
            Self::Control => "control and preprocessor terms",
            Self::Command => "commands",
            Self::Attribute => "attributes and settings",
            Self::Function => "value forms",
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ProfileInventory {
    pub profile: String,
    pub terms: Vec<(String, InventoryClass)>,
    pub definitions: Vec<String>,
    pub run_setting_labels: Vec<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CoverageReport {
    pub missing: Vec<String>,
    pub text: String,
}

pub fn coverage(
    catalog: &DocumentationCatalog,
    inventories: &[ProfileInventory],
) -> CoverageReport {
    let mut missing = Vec::new();
    let mut text = String::new();
    let _ = writeln!(text, "# RMS documentation coverage\n");
    let _ = writeln!(
        text,
        "Generated by the documentation coverage test from catalog `{}` (schema {}). \
         Do not edit by hand.\n",
        catalog.catalog_id, catalog.schema_version
    );
    let gaps = catalog
        .evidence_gaps
        .iter()
        .map(|gap| (gap.term.as_str(), gap))
        .collect::<BTreeMap<_, _>>();
    let mut inventory_terms = BTreeSet::new();
    for inventory in inventories {
        if !catalog.profiles.contains(&inventory.profile) {
            missing.push(format!(
                "profile {} is not listed by the catalog",
                inventory.profile
            ));
        }
        let _ = writeln!(text, "## Profile `{}`\n", inventory.profile);
        let _ = writeln!(
            text,
            "| Class | Known | Documented | Evidence gaps | Engine-verified | Documented elsewhere | Uncertain |"
        );
        let _ = writeln!(text, "| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
        let mut by_class = BTreeMap::<InventoryClass, [usize; 6]>::new();
        for (name, class) in &inventory.terms {
            inventory_terms.insert(name.as_str());
            let counts = by_class.entry(*class).or_default();
            counts[0] += 1;
            match catalog.term(name) {
                Some(term) => {
                    counts[1] += 1;
                    match term.evidence.status {
                        EvidenceStatus::EngineVerified => counts[3] += 1,
                        EvidenceStatus::Documented => counts[4] += 1,
                        EvidenceStatus::Uncertain => counts[5] += 1,
                    }
                }
                None if gaps.contains_key(name.as_str()) => counts[2] += 1,
                None => missing.push(format!("{}: {name} has no entry", inventory.profile)),
            }
        }
        for (class, counts) in &by_class {
            let _ = writeln!(
                text,
                "| {} | {} | {} | {} | {} | {} | {} |",
                class.label(),
                counts[0],
                counts[1],
                counts[2],
                counts[3],
                counts[4],
                counts[5]
            );
        }
        let _ = writeln!(text);
        let mut family_counts = BTreeMap::<&str, usize>::new();
        for name in &inventory.definitions {
            match catalog.definition_family(name) {
                Some(family) => *family_counts.entry(family.id.as_str()).or_default() += 1,
                None => missing.push(format!(
                    "{}: built-in name {name} belongs to no documented family",
                    inventory.profile
                )),
            }
        }
        let mut label_count = 0;
        for label in &inventory.run_setting_labels {
            match catalog.run_setting_family(label) {
                Some(family) => {
                    label_count += 1;
                    if family.member_note(label).is_none() {
                        missing.push(format!(
                            "{}: run-setting label {label} has no note",
                            inventory.profile
                        ));
                    }
                }
                None => missing.push(format!(
                    "{}: run-setting label {label} belongs to no documented family",
                    inventory.profile
                )),
            }
        }
        let _ = writeln!(text, "| Built-in family | Names |");
        let _ = writeln!(text, "| --- | ---: |");
        for family in &catalog.families {
            if family.source == FamilySource::Definitions {
                let _ = writeln!(
                    text,
                    "| {} (`{}`) | {} |",
                    family.title,
                    family.id,
                    family_counts.get(family.id.as_str()).copied().unwrap_or(0)
                );
            }
        }
        let _ = writeln!(text, "| Run-setting labels | {label_count} |\n");
    }
    for term in catalog.terms() {
        if !inventory_terms.contains(term.name.as_str()) {
            missing.push(format!(
                "{} is documented but no profile knows it",
                term.name
            ));
        }
    }
    let _ = writeln!(text, "## Evidence gaps\n");
    if catalog.evidence_gaps.is_empty() {
        let _ = writeln!(text, "None: every known term has a reviewed entry.\n");
    } else {
        for gap in &catalog.evidence_gaps {
            let _ = writeln!(
                text,
                "- `{}` (reviewed {}): {}",
                gap.term, gap.reviewed, gap.reason
            );
        }
        let _ = writeln!(text);
    }
    let _ = writeln!(text, "## Entries with uncertain claims\n");
    let uncertain = catalog
        .terms()
        .iter()
        .filter(|term| term.evidence.status == EvidenceStatus::Uncertain)
        .collect::<Vec<_>>();
    if uncertain.is_empty() {
        let _ = writeln!(text, "None.");
    }
    for term in uncertain {
        let _ = writeln!(
            text,
            "- `{}`: {}",
            term.name,
            term.evidence.note.as_deref().unwrap_or("see the entry")
        );
    }
    let _ = writeln!(text, "\n## Snippets\n");
    for snippet in &catalog.snippets {
        let _ = writeln!(text, "- `{}`: {}", snippet.label, snippet.summary);
    }
    CoverageReport { missing, text }
}
