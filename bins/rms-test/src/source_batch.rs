use std::collections::BTreeMap;

use anyhow::{Result, bail};
use rms_source::{
    SOURCE_CATALOG_MAX_AGGREGATE_BYTES, SOURCE_CATALOG_MAX_METADATA_BYTES,
    SOURCE_CATALOG_MAX_SOURCES, SourceCatalog,
};

const MAX_ROOTS: usize = 64;

pub(super) fn validate(catalogs: &BTreeMap<String, SourceCatalog>) -> Result<()> {
    check("roots", catalogs.len(), MAX_ROOTS)?;
    let mut records = 0_usize;
    let mut bodies = 0_usize;
    let mut metadata = 0_usize;
    for catalog in catalogs.values() {
        records = records.saturating_add(catalog.sources().len());
        check("records", records, SOURCE_CATALOG_MAX_SOURCES)?;
        metadata = metadata.saturating_add(
            catalog.entry_path().len()
                + catalog.profile_id().len()
                + catalog.content_identity().len(),
        );
        let roots = catalog.roots();
        for root in roots
            .opened_or_configured
            .iter()
            .chain(roots.deployed_map_context.iter())
            .chain(roots.game_gamedata_x2.iter())
            .chain(roots.implicit_environment.iter())
            .chain(roots.game_xs.iter())
        {
            metadata = metadata.saturating_add(root.len() + 8);
        }
        for name in &roots.standard_includes.identifiers {
            metadata = metadata.saturating_add(name.len() + 8);
        }
        for (name, value) in catalog.implicit_definitions() {
            metadata = metadata.saturating_add(name.len() + value.len() + 16);
        }
        for source in catalog.sources() {
            bodies = bodies.saturating_add(source.bytes.len());
            metadata =
                metadata.saturating_add(source.path.len() + source.source_id.as_str().len() + 64);
            check("bytes", bodies, SOURCE_CATALOG_MAX_AGGREGATE_BYTES)?;
            check("metadata", metadata, SOURCE_CATALOG_MAX_METADATA_BYTES)?;
        }
    }
    Ok(())
}

fn check(limit: &str, used: usize, maximum: usize) -> Result<()> {
    if used > maximum {
        bail!(
            "Map-test source batch exceeds its {limit} limit ({used}/{maximum}). Run fewer maps in one test."
        );
    }
    Ok(())
}
