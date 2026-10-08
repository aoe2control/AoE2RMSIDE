use super::*;
use rms_source::{SOURCE_CATALOG_MAX_FILE_BYTES, SOURCE_CATALOG_MAX_SOURCES, VirtualSourceKind};

const MAX_DISCOVERY_METADATA_BYTES: usize = 2 * 1024 * 1024;
const MAX_FILENAME_VARIANTS: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PotentialInclude {
    pub path: IncludePath,
    pub kind: VirtualSourceKind,
    pub source_range: ByteRange,
}

pub fn discover_include_requests(
    source: &SourceText,
    options: &StrictParseOptions,
) -> Result<Vec<PotentialInclude>, StrictParseError> {
    let error = |message: &str, range| StrictParseError {
        kind: StrictParseErrorKind::ResourceLimit,
        code: "RMS2045",
        message: message.to_owned(),
        source_chain: vec![source.id().clone()],
        range,
    };
    if source.bytes().len() > SOURCE_CATALOG_MAX_FILE_BYTES {
        return Err(error(
            "include discovery source exceeds the 4 MiB file bound",
            None,
        ));
    }
    let statements = lex_statements(source, options.limits.lexer);
    if let Some((kind, code, message, range)) = statements.failure {
        return Err(StrictParseError {
            kind,
            code,
            message,
            source_chain: vec![source.id().clone()],
            range: Some(range),
        });
    }
    let initial = Parser::new(None, options.clone());
    let alias_rms = options
        .semantic_token_aliases
        .values()
        .any(|value| matches!(value.as_str(), "#include" | "#include_drs"));
    let alias_xs = options
        .semantic_token_aliases
        .values()
        .any(|value| value == "#includeXS");
    let mut requests = BTreeMap::new();
    let mut metadata_bytes = 0_usize;
    let mut variants_visited = 0_usize;
    for line in &statements.lines {
        for (index, (_, word, range)) in line.significant.iter().enumerate() {
            let semantic = initial.semantic_spelling(word).map_err(|mut failure| {
                failure.source_chain = vec![source.id().clone()];
                failure.range = Some(*range);
                failure
            })?;
            let rms = alias_rms || matches!(semantic.as_str(), "#include" | "#include_drs");
            let xs = alias_xs || semantic == "#includeXS";
            if !rms && !xs {
                continue;
            }
            let operands = &line.significant[index + 1..];
            let mut add = |name: Option<String>| {
                let Some(name) = name else {
                    return Ok(());
                };
                let Ok(path) = IncludePath::new(name) else {
                    return Ok(());
                };
                for (selected, ordinal, kind) in [
                    (rms, 0_u8, VirtualSourceKind::RmsText),
                    (xs, 1_u8, VirtualSourceKind::ExternalXs),
                ] {
                    if !selected || requests.contains_key(&(ordinal, path.as_str().to_owned())) {
                        continue;
                    }
                    if requests.len() >= SOURCE_CATALOG_MAX_SOURCES {
                        return Err(error(
                            "potential include count exceeds the 4096-request discovery bound",
                            Some(*range),
                        ));
                    }
                    metadata_bytes = metadata_bytes.saturating_add(path.as_str().len() + 32);
                    if metadata_bytes > MAX_DISCOVERY_METADATA_BYTES {
                        return Err(error(
                            "potential include names exceed the 2 MiB discovery metadata bound",
                            Some(*range),
                        ));
                    }
                    requests.insert(
                        (ordinal, path.as_str().to_owned()),
                        PotentialInclude {
                            path: path.clone(),
                            kind,
                            source_range: *range,
                        },
                    );
                }
                Ok::<(), StrictParseError>(())
            };
            add(include_filename_words(operands).1)?;
            if options.lexical_profile.block_comments
                && operands
                    .iter()
                    .any(|(_, word, _)| matches!(word.as_str(), "/*" | "*/"))
            {
                let mut variants = vec![Vec::new()];
                for (word_index, _) in operands.iter().enumerate() {
                    let before = variants.len();
                    variants_visited = variants_visited.saturating_add(before);
                    if variants_visited > MAX_FILENAME_VARIANTS {
                        return Err(error(
                            "comment-dependent include filenames exceed the 4096-variant discovery work bound",
                            Some(*range),
                        ));
                    }
                    for variant in 0..before {
                        let mut retained = variants[variant].clone();
                        retained.push(word_index);
                        variants.push(retained);
                    }
                }
                for variant in &variants {
                    add(include_filename_word_values(
                        variant.iter().map(|&index| operands[index].1.as_str()),
                    )
                    .1)?;
                }
            }
        }
    }
    Ok(requests.into_values().collect())
}
