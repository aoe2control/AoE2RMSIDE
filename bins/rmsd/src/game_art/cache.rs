use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

pub(crate) const CONVERTER_VERSION: &str = "rmside-game-art-1.2.0";
pub(crate) const MANIFEST_FORMAT: &str = "rmside-game-art-cache";
pub(crate) const CACHE_CAP_BYTES: u64 = 128 * 1024 * 1024;
pub(crate) const DOCUMENT_ALLOWANCE_BYTES: u64 = 8 * 1024 * 1024;
const ENTRY_CAP_BYTES: u64 = CACHE_CAP_BYTES - DOCUMENT_ALLOWANCE_BYTES;
pub(crate) const UNUSED_SECONDS: u64 = 30 * 24 * 60 * 60;
const MAXIMUM_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const KEY_LENGTH: usize = 32;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Stamp {
    pub(crate) size: u64,
    pub(crate) modified: u64,
}

impl Stamp {
    pub(crate) fn of(metadata: &fs::Metadata) -> Self {
        Self {
            size: metadata.len(),
            modified: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |duration| {
                    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
                }),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Entry {
    pub(crate) source: String,
    pub(crate) stamp: Stamp,
    pub(crate) files: Vec<String>,
    pub(crate) bytes: u64,
    pub(crate) last_used: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Manifest {
    pub(crate) format: String,
    pub(crate) converter: String,
    pub(crate) product_version: String,
    pub(crate) last_used: u64,
    pub(crate) dat: Option<Stamp>,
    pub(crate) entries: BTreeMap<String, Entry>,
}

impl Manifest {
    fn empty(product_version: &str, now: u64) -> Self {
        Self {
            format: MANIFEST_FORMAT.to_owned(),
            converter: CONVERTER_VERSION.to_owned(),
            product_version: product_version.to_owned(),
            last_used: now,
            dat: None,
            entries: BTreeMap::new(),
        }
    }

    pub(crate) fn total_bytes(&self) -> u64 {
        self.entries.values().map(|entry| entry.bytes).sum()
    }
}

pub(crate) fn cache_key(canonical_root: &Path, product_version: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"rmside-game-art-key-v1\0");
    hasher.update(canonical_root.to_string_lossy().to_lowercase().as_bytes());
    hasher.update([0]);
    hasher.update(product_version.as_bytes());
    hasher
        .finalize()
        .iter()
        .take(KEY_LENGTH / 2)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_key(name: &str) -> bool {
    name.len() == KEY_LENGTH
        && name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) struct Cache {
    pub(crate) directory: PathBuf,
    pub(crate) key: String,
    pub(crate) manifest: Manifest,
    pub(crate) pinned: BTreeSet<String>,
    pub(crate) evicted: u32,
}

#[derive(Debug)]
pub(crate) struct CacheError(pub(crate) String);

impl Cache {
    pub(crate) fn open(
        versions: &Path,
        key: String,
        product_version: &str,
        now: u64,
    ) -> Result<Self, CacheError> {
        let mut evicted = remove_unused_keys(versions, &key, now);
        let directory = versions.join(&key);
        fs::create_dir_all(&directory)
            .map_err(|_| CacheError("the cache directory could not be created".to_owned()))?;
        let manifest = read_manifest(&directory).filter(|manifest| {
            manifest.format == MANIFEST_FORMAT
                && manifest.converter == CONVERTER_VERSION
                && manifest.product_version == product_version
        });
        let manifest = match manifest {
            Some(mut manifest) => {
                manifest.last_used = now;
                manifest
            }
            None => {
                let _ = fs::remove_dir_all(&directory);
                fs::create_dir_all(&directory).map_err(|_| {
                    CacheError("the cache directory could not be created".to_owned())
                })?;
                Manifest::empty(product_version, now)
            }
        };
        let mut cache = Self {
            directory,
            key,
            manifest,
            pinned: BTreeSet::new(),
            evicted: 0,
        };
        evicted += cache.remove_unused_entries(now);
        cache.evicted = evicted;
        Ok(cache)
    }

    fn remove_unused_entries(&mut self, now: u64) -> u32 {
        let stale = self
            .manifest
            .entries
            .iter()
            .filter(|(key, entry)| {
                key.starts_with("sprite/") && now.saturating_sub(entry.last_used) > UNUSED_SECONDS
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in &stale {
            self.remove_entry(key);
        }
        stale.len() as u32
    }

    pub(crate) fn reusable(&mut self, key: &str, stamp: Stamp, now: u64) -> bool {
        let present = self.manifest.entries.get(key).is_some_and(|entry| {
            entry.stamp == stamp
                && entry
                    .files
                    .iter()
                    .all(|file| self.directory.join(file).is_file())
        });
        if present {
            if let Some(entry) = self.manifest.entries.get_mut(key) {
                entry.last_used = now;
            }
            self.pinned.insert(key.to_owned());
        }
        present
    }

    pub(crate) fn remove_entry(&mut self, key: &str) {
        if let Some(entry) = self.manifest.entries.remove(key) {
            for file in entry.files {
                let _ = fs::remove_file(self.directory.join(file));
            }
        }
    }

    pub(crate) fn reserve(&mut self, bytes: u64) -> bool {
        while self.manifest.total_bytes().saturating_add(bytes) > ENTRY_CAP_BYTES {
            let victim = self
                .manifest
                .entries
                .iter()
                .filter(|(key, _)| key.starts_with("sprite/") && !self.pinned.contains(*key))
                .min_by_key(|(key, entry)| (entry.last_used, (*key).clone()))
                .map(|(key, _)| key.clone());
            match victim {
                Some(key) => {
                    self.remove_entry(&key);
                    self.evicted += 1;
                }
                None => return false,
            }
        }
        true
    }

    pub(crate) fn store(
        &mut self,
        key: &str,
        source: String,
        stamp: Stamp,
        files: Vec<(String, Vec<u8>)>,
        now: u64,
    ) -> Result<(), CacheError> {
        let bytes = files.iter().map(|(_, data)| data.len() as u64).sum();
        self.remove_entry(key);
        let mut names = Vec::with_capacity(files.len());
        for (name, data) in files {
            write_atomically(&self.directory.join(&name), &data)?;
            names.push(name);
        }
        self.manifest.entries.insert(
            key.to_owned(),
            Entry {
                source,
                stamp,
                files: names,
                bytes,
                last_used: now,
            },
        );
        self.pinned.insert(key.to_owned());
        Ok(())
    }

    pub(crate) fn save(&self) -> Result<(), CacheError> {
        let bytes = serde_json::to_vec_pretty(&self.manifest)
            .map_err(|_| CacheError("the cache manifest could not be encoded".to_owned()))?;
        write_atomically(&self.directory.join("manifest.json"), &bytes)
    }

    pub(crate) fn write_document(
        &self,
        name: &str,
        value: &impl Serialize,
    ) -> Result<(), CacheError> {
        let bytes = serde_json::to_vec_pretty(value)
            .map_err(|_| CacheError(format!("{name} could not be encoded")))?;
        write_atomically(&self.directory.join(name), &bytes)
    }

    pub(crate) fn read_document<T: for<'de> Deserialize<'de>>(&self, name: &str) -> Option<T> {
        read_bounded(&self.directory.join(name))
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }

    pub(crate) fn total_bytes(&self) -> u64 {
        let documents = ["manifest.json", "index.json", "sprites.json"]
            .iter()
            .filter_map(|name| fs::metadata(self.directory.join(name)).ok())
            .map(|metadata| metadata.len())
            .sum::<u64>();
        self.manifest.total_bytes() + documents
    }
}

fn read_bounded(path: &Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let file = fs::File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAXIMUM_MANIFEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= MAXIMUM_MANIFEST_BYTES).then_some(bytes)
}

fn read_manifest(directory: &Path) -> Option<Manifest> {
    serde_json::from_slice(&read_bounded(&directory.join("manifest.json"))?).ok()
}

fn remove_unused_keys(versions: &Path, current: &str, now: u64) -> u32 {
    let Ok(entries) = fs::read_dir(versions) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name == current || !is_key(name) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let path = entry.path();
        let last_used = read_manifest(&path)
            .map(|manifest| manifest.last_used)
            .or_else(|| {
                entry
                    .metadata()
                    .ok()?
                    .modified()
                    .ok()?
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .map(|duration| duration.as_secs())
            });
        if last_used.is_some_and(|last| now.saturating_sub(last) > UNUSED_SECONDS)
            && fs::remove_dir_all(&path).is_ok()
        {
            removed += 1;
        }
    }
    removed
}

static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), CacheError> {
    let failure = || CacheError("a cache file could not be written".to_owned());
    let parent = path.parent().ok_or_else(failure)?;
    fs::create_dir_all(parent).map_err(|_| failure())?;
    let temporary = parent.join(format!(
        ".{}-{}.tmp",
        std::process::id(),
        TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(failure());
    }
    Ok(())
}
