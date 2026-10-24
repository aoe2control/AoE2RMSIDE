use sha2::{Digest, Sha256};
use thiserror::Error;

pub const HASH_RULE: &str = "rmside-connect-catalog-v1";
pub const MANIFEST_PATH: &str = "catalog.json";
pub const MAX_CATALOG_FILES: usize = 64;
pub const MAX_CATALOG_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_CATALOG_PATH_BYTES: usize = 96;

#[derive(Clone, Copy, Debug)]
pub struct CatalogFile<'a> {
    pub path: &'a str,
    pub bytes: &'a [u8],
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum CatalogError {
    #[error("the catalog has no files or more than {MAX_CATALOG_FILES}")]
    FileCount,
    #[error("the catalog path {0:?} is not a canonical relative path")]
    Path(String),
    #[error("the catalog paths are not sorted and unique at {0:?}")]
    Order(String),
    #[error("the catalog file {0:?} is not UTF-8 without a byte order mark")]
    Encoding(String),
    #[error("the catalog file {0:?} holds a carriage return outside CRLF")]
    LoneCarriageReturn(String),
    #[error("the canonical catalog exceeds {MAX_CATALOG_BYTES} bytes")]
    TooLarge,
}

pub fn is_catalog_path(path: &str) -> bool {
    path.len() <= MAX_CATALOG_PATH_BYTES
        && path != MANIFEST_PATH
        && path.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment.bytes().all(|byte| {
                    byte.is_ascii_lowercase()
                        || byte.is_ascii_digit()
                        || matches!(byte, b'.' | b'_' | b'-')
                })
        })
}

pub fn canonical_bytes(files: &[CatalogFile<'_>]) -> Result<Vec<u8>, CatalogError> {
    if files.is_empty() || files.len() > MAX_CATALOG_FILES {
        return Err(CatalogError::FileCount);
    }
    let mut canonical = Vec::new();
    canonical.extend_from_slice(HASH_RULE.as_bytes());
    canonical.push(b'\n');
    let mut previous: Option<&str> = None;
    for file in files {
        if !is_catalog_path(file.path) {
            return Err(CatalogError::Path(file.path.to_owned()));
        }
        if previous.is_some_and(|previous| previous.as_bytes() >= file.path.as_bytes()) {
            return Err(CatalogError::Order(file.path.to_owned()));
        }
        previous = Some(file.path);
        let text = std::str::from_utf8(file.bytes)
            .map_err(|_| CatalogError::Encoding(file.path.to_owned()))?;
        if text.starts_with('\u{feff}') {
            return Err(CatalogError::Encoding(file.path.to_owned()));
        }
        let normalized = text.replace("\r\n", "\n");
        if normalized.contains('\r') {
            return Err(CatalogError::LoneCarriageReturn(file.path.to_owned()));
        }
        canonical.extend_from_slice(file.path.as_bytes());
        canonical.push(b'\n');
        canonical.extend_from_slice(normalized.len().to_string().as_bytes());
        canonical.push(b'\n');
        canonical.extend_from_slice(normalized.as_bytes());
        canonical.push(b'\n');
        if canonical.len() > MAX_CATALOG_BYTES {
            return Err(CatalogError::TooLarge);
        }
    }
    Ok(canonical)
}

pub fn catalog_hash(files: &[CatalogFile<'_>]) -> Result<[u8; 32], CatalogError> {
    Ok(Sha256::digest(canonical_bytes(files)?).into())
}

pub fn catalog_hash_hex(files: &[CatalogFile<'_>]) -> Result<String, CatalogError> {
    Ok(crate::key::lower_hex(&catalog_hash(files)?))
}
