use super::*;
use rms_semantics::discover_include_requests;
use rms_source::{
    SOURCE_CATALOG_MAX_FILE_BYTES, SOURCE_CATALOG_MAX_ROOTS, SOURCE_CATALOG_MAX_SOURCES,
    VirtualSourceKind,
};

const METADATA_LIMIT: usize = 2 * 1024 * 1024;

pub(super) fn request(params: &Value) -> RequestResult<Value> {
    let version = required(params, "contractVersion")?;
    if json_u32(required(version, "major")?)? != 1
        || json_u32(required(version, "minor")?)? != 0
        || json_u32(required(version, "patch")?)? != 0
    {
        return Err(RequestError::invalid(
            "source discovery contract version is unsupported",
        ));
    }
    match string_field(params, "operation")? {
        "scan" => scan(params),
        "lookup" => lookup(params),
        _ => Err(RequestError::invalid(
            "source discovery operation is invalid",
        )),
    }
}

fn response(mut fields: Value) -> Value {
    fields["contractVersion"] = json!({"major": 1, "minor": 0, "patch": 0});
    fields
}

fn metadata_size(value: &Value) -> RequestResult<()> {
    if serde_json::to_vec(value)
        .map_err(|error| RequestError::invalid(error.to_string()))?
        .len()
        > METADATA_LIMIT
    {
        return Err(RequestError::unavailable(
            "source discovery metadata exceeds the 2 MiB bound",
        ));
    }
    Ok(())
}

fn scan(params: &Value) -> RequestResult<Value> {
    let definitions = required(params, "implicitDefinitions")?;
    metadata_size(definitions)?;
    let definitions = definitions
        .as_object()
        .ok_or_else(|| RequestError::invalid("source discovery definitions must be an object"))?;
    if definitions.len() > 65_536 {
        return Err(RequestError::invalid(
            "source discovery definition count exceeds its bound",
        ));
    }
    let vocabulary = definitions
        .iter()
        .map(|(name, value)| {
            let value = value
                .as_str()
                .ok_or_else(|| RequestError::invalid("source discovery definition is invalid"))?;
            if name.is_empty() || name.len() > 256 || value.is_empty() || value.len() > 256 {
                return Err(RequestError::invalid(
                    "source discovery definition exceeds its bound",
                ));
            }
            Ok((name.clone(), value.to_owned()))
        })
        .collect::<RequestResult<BTreeMap<_, _>>>()?;
    let profile_id = string_field(params, "profileId")?;
    if profile_id.is_empty() || profile_id.len() > 256 {
        return Err(RequestError::invalid(
            "source discovery profile identifier is invalid",
        ));
    }
    let options = product_strict_options_for_profile(profile_id, &vocabulary)
        .map_err(RequestError::invalid)?;
    let encoded = string_field(params, "sourceBase64")?;
    if encoded.len() > SOURCE_CATALOG_MAX_FILE_BYTES.div_ceil(3) * 4 {
        return Err(RequestError::unavailable(
            "source discovery source exceeds the 4 MiB file bound",
        ));
    }
    let source_id = SourceId::new(string_field(params, "sourceId")?.to_owned())
        .map_err(|error| RequestError::invalid(error.to_string()))?;
    let source = SourceText::from_bytes(source_id, decode_base64(encoded)?)
        .map_err(|error| RequestError::invalid(error.to_string()))?;
    let requests = discover_include_requests(&source, &options)
        .map_err(|error| RequestError::unavailable(format!("{}: {}", error.code, error.message)))?;
    let result = response(json!({"requests": requests.iter().map(|request| json!({
        "path": request.path.as_str(),
        "kind": match request.kind { VirtualSourceKind::RmsText => "rms", VirtualSourceKind::ExternalXs => "xs" },
        "byteStart": request.source_range.start.0,
        "byteEnd": request.source_range.end.0,
    })).collect::<Vec<_>>() }));
    metadata_size(&result)?;
    Ok(result)
}

fn parse_roots(value: &Value) -> RequestResult<ResolverRoots> {
    let opened = required(value, "openedOrConfigured")?
        .as_array()
        .ok_or_else(|| RequestError::invalid("source discovery roots must be an array"))?;
    let additional_roots = [
        "deployedMapContext",
        "gameGamedataX2",
        "implicitEnvironment",
        "gameXs",
    ]
    .iter()
    .filter(|name| value.get(**name).is_some_and(|value| !value.is_null()))
    .count();
    if opened.len().saturating_add(additional_roots) > SOURCE_CATALOG_MAX_ROOTS {
        return Err(RequestError::invalid(
            "source discovery root count exceeds its bound",
        ));
    }
    Ok(ResolverRoots {
        opened_or_configured: opened
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| RequestError::invalid("source discovery root is invalid"))
            })
            .collect::<RequestResult<_>>()?,
        deployed_map_context: optional_string_field(value, "deployedMapContext")?,
        game_gamedata_x2: optional_string_field(value, "gameGamedataX2")?,
        implicit_environment: optional_string_field(value, "implicitEnvironment")?,
        game_xs: optional_string_field(value, "gameXs")?,
        standard_includes: standard_include_access(value)?,
    })
}

fn lookup(params: &Value) -> RequestResult<Value> {
    metadata_size(params)?;
    let source_path = string_field(params, "sourcePath")?;
    let mut roots = parse_roots(required(params, "roots")?)?;
    let case_sensitive = required(params, "caseSensitive")?
        .as_bool()
        .ok_or_else(|| RequestError::invalid("source discovery case policy is invalid"))?;
    let resolver = VirtualSourceResolver::new(Vec::new(), roots.clone(), case_sensitive)
        .map_err(|error| RequestError::invalid(error.to_string()))?;
    let requests = required(params, "requests")?
        .as_array()
        .ok_or_else(|| RequestError::invalid("source discovery requests must be an array"))?;
    if requests.len() > SOURCE_CATALOG_MAX_SOURCES {
        return Err(RequestError::unavailable(
            "source discovery exceeds its 4096-request bound",
        ));
    }
    let requests = requests
        .iter()
        .map(|request| {
            let path = IncludePath::new(string_field(request, "path")?)
                .map_err(|error| RequestError::invalid(error.to_string()))?;
            let kind = match string_field(request, "kind")? {
                "rms" => VirtualSourceKind::RmsText,
                "xs" => VirtualSourceKind::ExternalXs,
                _ => {
                    return Err(RequestError::invalid(
                        "source discovery include kind is invalid",
                    ));
                }
            };
            Ok((path, kind))
        })
        .collect::<RequestResult<Vec<_>>>()?;
    let namespace_paths = requests
        .iter()
        .filter_map(|(path, kind)| resolver.standard_namespace_probe(path, *kind))
        .collect::<BTreeSet<_>>();
    let evidence = required(params, "namespaceEvidence")?
        .as_array()
        .ok_or_else(|| RequestError::invalid("include search results must be a list"))?;
    if evidence.len() > SOURCE_CATALOG_MAX_SOURCES {
        return Err(RequestError::unavailable(
            "include search results exceed the 4096-result limit",
        ));
    }
    let mut observed = BTreeMap::new();
    for probe in evidence {
        let path = string_field(probe, "path")?;
        let present = required(probe, "present")?
            .as_bool()
            .ok_or_else(|| RequestError::invalid("source discovery probe result is invalid"))?;
        if !namespace_paths.contains(path) || observed.insert(path.to_owned(), present).is_some() {
            return Err(RequestError::invalid(
                "include search results contain an unexpected or duplicate path",
            ));
        }
    }
    let pending = namespace_paths
        .iter()
        .filter(|path| !observed.contains_key(*path))
        .cloned()
        .collect::<Vec<_>>();
    if !pending.is_empty() {
        let result = response(json!({"namespacePaths": pending}));
        metadata_size(&result)?;
        return Ok(result);
    }
    for (include, kind) in &requests {
        if resolver
            .standard_namespace_probe(include, *kind)
            .is_some_and(|path| observed.get(&path) == Some(&true))
        {
            roots
                .standard_includes
                .identifiers
                .push(include.as_str().to_owned());
        }
    }
    roots.standard_includes = StandardIncludeAccess::new(
        &roots.standard_includes.identifiers,
        roots.standard_includes.authorized,
    )
    .map_err(|error| RequestError::invalid(error.to_string()))?;
    let resolver = VirtualSourceResolver::new(Vec::new(), roots.clone(), case_sensitive)
        .map_err(|error| RequestError::invalid(error.to_string()))?;
    let mut unique_paths = BTreeSet::new();
    let mut plans = Vec::with_capacity(requests.len());
    for (include, kind) in requests {
        let paths = match resolver.lookup_paths(source_path, &include, &[], kind) {
            Ok(paths) => paths,
            Err(error) if error.kind == ResolutionDiagnosticKind::StandardIncludeUnavailable => {
                plans.push(json!({"path": include.as_str(), "kind": kind_name(kind), "paths": [], "blocked": "standard-include-unavailable"}));
                continue;
            }
            Err(error) => return Err(RequestError::invalid(error.to_string())),
        };
        unique_paths.extend(paths.iter().cloned());
        if unique_paths.len() > SOURCE_CATALOG_MAX_SOURCES {
            return Err(RequestError::unavailable(
                "source discovery candidate paths exceed the 4096-probe bound",
            ));
        }
        plans.push(json!({"path": include.as_str(), "kind": kind_name(kind), "paths": paths}));
    }
    let result =
        response(json!({"standardIncludes": roots.standard_includes.identifiers, "plans": plans}));
    metadata_size(&result)?;
    Ok(result)
}

fn kind_name(kind: VirtualSourceKind) -> &'static str {
    match kind {
        VirtualSourceKind::RmsText => "rms",
        VirtualSourceKind::ExternalXs => "xs",
    }
}
