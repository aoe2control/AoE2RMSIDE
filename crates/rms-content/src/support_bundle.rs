use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::dat_import::{
    ContentCompletenessManifest, implicit_definitions_canonical_sha256,
    native_bindings_canonical_sha256,
};
use crate::native_bindings::{NativeContentBindings, load_native_content_bindings};
use crate::standard_resource::{
    StandardIncludeInventory, load_canonical_standard_include_inventory,
};
use crate::{
    CompatibilityRange, ContentError, ContentSource, ContentSourceKind, NeutralContentPack,
    hex_bytes, load_canonical_implicit_definitions,
};

pub const SUPPORT_BUNDLE_SCHEMA: &str = "https://rmside.invalid/schemas/support-bundle/v1";
pub const SUPPORT_BUNDLE_SCHEMA_VERSION: &str = "1.0.0";
const MAXIMUM_MANIFEST_BYTES: usize = 64 * 1024;
const MAXIMUM_COMPLETENESS_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupportBundleContent {
    pub pack_id: String,
    pub pack_version: String,
    pub content_hash: String,
    pub file_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupportBundleDefinitions {
    pub count: u32,
    pub file_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupportBundleManifest {
    #[serde(rename = "$schema")]
    pub schema: String,
    pub schema_version: String,
    pub compatibility: CompatibilityRange,
    pub bundle_id: String,
    pub product_version: String,
    pub behavior_profile_id: String,
    pub behavior_profile_sha256: String,
    pub content_pack: SupportBundleContent,
    pub implicit_definitions: SupportBundleDefinitions,
    pub standard_includes_sha256: String,
    pub native_bindings_sha256: String,
    pub completeness_manifest_sha256: String,
}

pub struct SupportBundle {
    pub manifest: SupportBundleManifest,
    pub content: NeutralContentPack,
    pub implicit_definitions: BTreeMap<String, i32>,
    pub standard_includes: StandardIncludeInventory,
    pub native_bindings: NativeContentBindings,
    pub completeness: ContentCompletenessManifest,
}

impl SupportBundle {
    pub fn vocabulary(&self) -> Result<BTreeMap<String, String>, ContentError> {
        self.content.rms_implicit_definitions()
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_bytes(&Sha256::digest(bytes))
}

#[derive(Clone, Copy)]
struct BundleFiles<'a> {
    manifest: &'a [u8],
    content: &'a [u8],
    definitions: &'a [u8],
    standard_includes: &'a [u8],
    native_bindings: &'a [u8],
    completeness: &'a [u8],
    build: &'a str,
}

const PACKAGED: &[BundleFiles<'static>] = &[
    BundleFiles {
        manifest: include_bytes!("../data/aoe2de-101.103.48987-support-bundle.json"),
        content: include_bytes!("../data/aoe2de-101.103.48987-content-pack.json"),
        definitions: include_bytes!("../data/aoe2de-101.103.48987-implicit-definitions.json"),
        standard_includes: include_bytes!("../data/aoe2de-101.103.48987-standard-includes.json"),
        native_bindings: include_bytes!("../data/aoe2de-101.103.48987-native-bindings.json"),
        completeness: include_bytes!("../data/aoe2de-101.103.48987-content-completeness.json"),
        build: "101.103.48987",
    },
    BundleFiles {
        manifest: include_bytes!("../data/aoe2de-101.103.54800-support-bundle.json"),
        content: include_bytes!("../data/aoe2de-101.103.54800-content-pack.json"),
        definitions: include_bytes!("../data/aoe2de-101.103.54800-implicit-definitions.json"),
        standard_includes: include_bytes!("../data/aoe2de-101.103.54800-standard-includes.json"),
        native_bindings: include_bytes!("../data/aoe2de-101.103.54800-native-bindings.json"),
        completeness: include_bytes!("../data/aoe2de-101.103.54800-content-completeness.json"),
        build: "101.103.54800",
    },
];

fn load(files: &BundleFiles<'_>) -> Result<SupportBundle, ContentError> {
    if files.manifest.len() > MAXIMUM_MANIFEST_BYTES {
        return Err(ContentError::ResourceLimit("support bundle manifest"));
    }
    let manifest: SupportBundleManifest =
        serde_json::from_slice(files.manifest).map_err(ContentError::Parse)?;
    if manifest.schema != SUPPORT_BUNDLE_SCHEMA
        || manifest.schema_version != SUPPORT_BUNDLE_SCHEMA_VERSION
        || manifest.compatibility.minimum_major != 1
        || manifest.compatibility.maximum_major != 1
    {
        return Err(ContentError::UnsupportedSchema(manifest.schema_version));
    }
    if files.content.len() > crate::MAXIMUM_PACK_BYTES {
        return Err(ContentError::ResourceLimit("support bundle content pack"));
    }
    if files.completeness.len() > MAXIMUM_COMPLETENESS_BYTES {
        return Err(ContentError::ResourceLimit(
            "support bundle completeness manifest",
        ));
    }
    let content =
        serde_json::from_slice::<NeutralContentPack>(files.content).map_err(ContentError::Parse)?;
    let identity = content.identity()?;
    let implicit_definitions = load_canonical_implicit_definitions(files.definitions)?;
    let standard_includes =
        load_canonical_standard_include_inventory(files.standard_includes, files.build)?;
    let completeness = serde_json::from_slice::<ContentCompletenessManifest>(files.completeness)
        .map_err(ContentError::Parse)?;
    completeness.require_supported()?;
    let native_bindings =
        load_native_content_bindings(files.native_bindings, &manifest.behavior_profile_id)?;
    let expected = [
        (
            sha256_hex(files.content),
            &manifest.content_pack.file_sha256,
        ),
        (
            hex_bytes(&identity.content_hash),
            &manifest.content_pack.content_hash,
        ),
        (
            sha256_hex(files.definitions),
            &manifest.implicit_definitions.file_sha256,
        ),
        (
            sha256_hex(files.standard_includes),
            &manifest.standard_includes_sha256,
        ),
        (
            sha256_hex(files.native_bindings),
            &manifest.native_bindings_sha256,
        ),
        (
            sha256_hex(files.completeness),
            &manifest.completeness_manifest_sha256,
        ),
        (
            native_bindings_canonical_sha256(&native_bindings)?,
            &completeness.native_bindings_canonical_sha256,
        ),
        (
            implicit_definitions_canonical_sha256(&implicit_definitions)?,
            &completeness.implicit_definitions_canonical_sha256,
        ),
    ];
    if expected
        .iter()
        .any(|(actual, recorded)| actual != *recorded)
        || identity.pack_id != manifest.content_pack.pack_id
        || identity.pack_version != manifest.content_pack.pack_version
        || implicit_definitions.len() != manifest.implicit_definitions.count as usize
        || content.rms_implicit_definitions != implicit_definitions
        || content.source.kind != ContentSourceKind::ReviewedBundle
        || content.source.fingerprint != manifest.completeness_manifest_sha256
        || content.source.product_version_label.as_deref() != Some(&manifest.product_version)
        || !manifest
            .product_version
            .strip_prefix(files.build)
            .is_some_and(|revision| revision.starts_with('.'))
        || !content
            .compatible_behavior_profiles
            .contains(&manifest.behavior_profile_id)
        || completeness.behavior_profile_id != manifest.behavior_profile_id
        || !completeness_accounts_for(&completeness, &content)
        || completeness.implicit_definition_count as usize != implicit_definitions.len()
        || content.native_generation_bindings.as_ref()
            != Some(&native_bindings.native_generation_bindings)
    {
        return Err(ContentError::InvalidField(
            "packaged support bundle identity",
        ));
    }
    Ok(SupportBundle {
        manifest,
        content,
        implicit_definitions,
        standard_includes,
        native_bindings,
        completeness,
    })
}

fn completeness_accounts_for(
    completeness: &ContentCompletenessManifest,
    content: &NeutralContentPack,
) -> bool {
    let excluded_sorted_unique = completeness
        .excluded_objects
        .windows(2)
        .all(|pair| pair[0].object_id < pair[1].object_id);
    excluded_sorted_unique
        && completeness.excluded_objects.iter().all(|account| {
            content
                .objects
                .binary_search_by_key(&account.object_id, |object| object.id)
                .is_err()
        })
        && completeness.content_schema_version == content.schema_version
        && Some(completeness.dat_version_header.as_str())
            == content.source.dat_version_header.as_deref()
        && completeness.emitted_object_count as usize == content.objects.len()
        && completeness.emitted_object_count as usize + completeness.excluded_objects.len()
            == completeness.object_slot_count as usize
        && completeness.emitted_terrain_count as usize == content.terrains.len()
        && completeness.emitted_terrain_count == completeness.terrain_slot_count
        && completeness.restriction_count as usize == content.restrictions.len()
        && completeness.resource_count as usize == content.resources.len()
        && completeness.emitted_object_replacement_rule_count as usize
            == content.object_replacement_rules.len()
}

pub fn packaged_support_bundles() -> Result<&'static [SupportBundle], ContentError> {
    static BUNDLES: OnceLock<Result<Vec<SupportBundle>, String>> = OnceLock::new();
    BUNDLES
        .get_or_init(|| {
            PACKAGED
                .iter()
                .map(load)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())
        })
        .as_deref()
        .map_err(|_| ContentError::InvalidField("packaged support bundle"))
}

pub fn packaged_support_bundle(
    pack_id: &str,
    pack_version: &str,
) -> Result<Option<&'static SupportBundle>, ContentError> {
    Ok(packaged_support_bundles()?.iter().find(|bundle| {
        bundle.manifest.content_pack.pack_id == pack_id
            && bundle.manifest.content_pack.pack_version == pack_version
    }))
}

pub struct SupportBundleInputs<'a> {
    pub pack: NeutralContentPack,
    pub completeness: ContentCompletenessManifest,
    pub definitions_bytes: &'a [u8],
    pub standard_includes_bytes: &'a [u8],
    pub native_bindings_bytes: &'a [u8],
    pub bundle_id: &'a str,
    pub pack_id: &'a str,
    pub pack_version: &'a str,
    pub product_version: &'a str,
    pub behavior_profile_sha256: &'a str,
}

pub struct SanitizedSupportBundle {
    pub content: Vec<u8>,
    pub completeness: Vec<u8>,
    pub manifest: Vec<u8>,
}

pub fn sanitize_support_bundle(
    inputs: SupportBundleInputs<'_>,
) -> Result<SanitizedSupportBundle, ContentError> {
    let completeness_bytes = pretty(&inputs.completeness)?;
    let completeness_sha256 = sha256_hex(&completeness_bytes);
    let mut pack = inputs.pack;
    pack.pack_id = inputs.pack_id.to_owned();
    pack.pack_version = inputs.pack_version.to_owned();
    pack.source = ContentSource {
        kind: ContentSourceKind::ReviewedBundle,
        fingerprint: completeness_sha256.clone(),
        product_version_label: Some(inputs.product_version.to_owned()),
        dat_version_header: pack.source.dat_version_header,
        object_replacement_fingerprint: pack
            .source
            .object_replacement_fingerprint
            .map(|_| completeness_sha256.clone()),
    };
    let content_bytes = pack.canonical_bytes()?;
    let identity = pack.identity()?;
    let definitions = load_canonical_implicit_definitions(inputs.definitions_bytes)?;
    let bindings = load_native_content_bindings(
        inputs.native_bindings_bytes,
        &inputs.completeness.behavior_profile_id,
    )?;
    inputs.completeness.require_supported()?;
    if definitions != pack.rms_implicit_definitions
        || implicit_definitions_canonical_sha256(&definitions)?
            != inputs.completeness.implicit_definitions_canonical_sha256
    {
        return Err(ContentError::InvalidField("support bundle definitions"));
    }
    if native_bindings_canonical_sha256(&bindings)?
        != inputs.completeness.native_bindings_canonical_sha256
        || pack.native_generation_bindings.as_ref() != Some(&bindings.native_generation_bindings)
    {
        return Err(ContentError::InvalidField(
            "support bundle generation bindings",
        ));
    }
    let manifest = SupportBundleManifest {
        schema: SUPPORT_BUNDLE_SCHEMA.to_owned(),
        schema_version: SUPPORT_BUNDLE_SCHEMA_VERSION.to_owned(),
        compatibility: CompatibilityRange {
            minimum_major: 1,
            maximum_major: 1,
        },
        bundle_id: inputs.bundle_id.to_owned(),
        product_version: inputs.product_version.to_owned(),
        behavior_profile_id: inputs.completeness.behavior_profile_id.clone(),
        behavior_profile_sha256: inputs.behavior_profile_sha256.to_owned(),
        content_pack: SupportBundleContent {
            pack_id: identity.pack_id,
            pack_version: identity.pack_version,
            content_hash: hex_bytes(&identity.content_hash),
            file_sha256: sha256_hex(&content_bytes),
        },
        implicit_definitions: SupportBundleDefinitions {
            count: definitions.len() as u32,
            file_sha256: sha256_hex(inputs.definitions_bytes),
        },
        standard_includes_sha256: sha256_hex(inputs.standard_includes_bytes),
        native_bindings_sha256: sha256_hex(inputs.native_bindings_bytes),
        completeness_manifest_sha256: completeness_sha256,
    };
    let manifest_bytes = pretty(&manifest)?;
    let build = inputs
        .product_version
        .rsplit_once('.')
        .map(|(build, _)| build)
        .ok_or(ContentError::InvalidField("support bundle product version"))?;
    load(&BundleFiles {
        manifest: &manifest_bytes,
        content: &content_bytes,
        definitions: inputs.definitions_bytes,
        standard_includes: inputs.standard_includes_bytes,
        native_bindings: inputs.native_bindings_bytes,
        completeness: &completeness_bytes,
        build,
    })?;
    Ok(SanitizedSupportBundle {
        content: content_bytes,
        completeness: completeness_bytes,
        manifest: manifest_bytes,
    })
}

fn pretty(value: &impl Serialize) -> Result<Vec<u8>, ContentError> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(ContentError::Serialize)?;
    bytes.push(b'\n');
    Ok(bytes)
}
