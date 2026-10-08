use std::path::PathBuf;
use std::sync::Arc;

use rms_content::{NeutralContentPack, packaged_support_bundles};
use rms_engine::local_content::{LocalContentError, LocalContentPaths, local_content_pack_id};
use rms_protocol::v1;

use super::{ProtocolFailure, content_pack_descriptor, malformed};

struct LocalContentFailure {
    status: v1::LocalContentImportStatus,
    message: String,
}

impl From<LocalContentError> for LocalContentFailure {
    fn from(error: LocalContentError) -> Self {
        let status = match &error {
            LocalContentError::Unreadable(_) => v1::LocalContentImportStatus::Unreadable,
            LocalContentError::UnsupportedLayout(_) => {
                v1::LocalContentImportStatus::UnsupportedLayout
            }
            LocalContentError::Invalid(_) => v1::LocalContentImportStatus::Invalid,
        };
        Self {
            status,
            message: error.to_string(),
        }
    }
}

fn local_content_pack(
    source: &v1::LocalContentSource,
) -> Result<(Arc<NeutralContentPack>, Option<std::time::Duration>), LocalContentFailure> {
    let paths = LocalContentPaths {
        dat: PathBuf::from(&source.dat_path),
        object_replacements: PathBuf::from(&source.object_replacements_path),
        definitions: PathBuf::from(&source.definitions_path),
    };
    Ok(rms_engine::local_content::local_content_pack(
        &paths,
        &source.product_version,
        &source.profile_id,
    )?)
}

pub(crate) fn local_content_import(
    request: &v1::LocalContentImportRequest,
) -> v1::LocalContentImportResponse {
    let failure =
        |status: v1::LocalContentImportStatus, message: String| v1::LocalContentImportResponse {
            status: status as i32,
            content_pack: None,
            message,
            import_microseconds: 0,
        };
    let Some(source) = request.source.as_ref() else {
        return failure(
            v1::LocalContentImportStatus::Invalid,
            "the local content source is required".to_owned(),
        );
    };
    match local_content_pack(source) {
        Ok((pack, elapsed)) => {
            let descriptor = packaged_support_bundles()
                .map_err(|error| error.to_string())
                .and_then(|bundles| {
                    content_pack_descriptor(&pack, bundles).map_err(|error| error.to_string())
                });
            match descriptor {
                Ok(descriptor) => v1::LocalContentImportResponse {
                    status: v1::LocalContentImportStatus::Available as i32,
                    content_pack: Some(descriptor),
                    message: String::new(),
                    import_microseconds: elapsed.map_or(0, |elapsed| {
                        elapsed.as_micros().min(u128::from(u64::MAX)) as u64
                    }),
                },
                Err(message) => failure(v1::LocalContentImportStatus::Invalid, message),
            }
        }
        Err(error) => failure(error.status, error.message),
    }
}

pub(crate) fn generation_local_content(
    request: &v1::GenerationRequest,
    source: &v1::LocalContentSource,
) -> Result<Arc<NeutralContentPack>, ProtocolFailure> {
    let expected_id = local_content_pack_id(&source.product_version)
        .map_err(|error| malformed(error.to_string()))?;
    if request.content_pack_id != expected_id
        || request.local_product_version != source.product_version
        || request.profile_id != source.profile_id
    {
        return Err(malformed(
            "local content must name its own pack, label, and profile",
        ));
    }
    local_content_pack(source)
        .map(|(pack, _)| pack)
        .map_err(|failure| {
            malformed(format!(
                "local generation content is unavailable: {}",
                failure.message
            ))
        })
}
