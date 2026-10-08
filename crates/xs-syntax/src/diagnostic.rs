use rms_source::{ByteRange, SourceId};

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum Severity {
    Error,
    Warning,
    Information,
    Hint,
}

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum DiagnosticTag {
    Unnecessary,
    Deprecated,
}

pub const MAXIMUM_RELATED_LOCATIONS: usize = 8;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelatedLocation {
    pub source_id: SourceId,
    pub range: ByteRange,
    pub message: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct XsDiagnostic {
    pub code: &'static str,
    pub severity: Severity,
    pub message: String,
    pub range: ByteRange,
    pub tags: Vec<DiagnosticTag>,
    pub related: Vec<RelatedLocation>,
}

impl XsDiagnostic {
    pub fn new(
        code: &'static str,
        severity: Severity,
        message: impl Into<String>,
        range: ByteRange,
    ) -> Self {
        Self {
            code,
            severity,
            message: message.into(),
            range,
            tags: Vec::new(),
            related: Vec::new(),
        }
    }

    pub fn error(code: &'static str, message: impl Into<String>, range: ByteRange) -> Self {
        Self::new(code, Severity::Error, message, range)
    }

    pub fn with_tag(mut self, tag: DiagnosticTag) -> Self {
        self.tags.push(tag);
        self
    }

    pub fn with_related(mut self, related: Option<RelatedLocation>) -> Self {
        if let Some(related) = related
            && self.related.len() < MAXIMUM_RELATED_LOCATIONS
        {
            self.related.push(related);
        }
        self
    }
}
