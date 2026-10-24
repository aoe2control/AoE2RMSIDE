use std::path::{Component, Path, PathBuf};

pub const DESKTOP_IMAGE: &str = "AoE2RMSIDE.exe";
pub const TEST_SERVER_IMAGE_VARIABLE: &str = "RMS_CONNECT_TEST_SERVER_IMAGE";

#[derive(Clone, Debug, Default)]
pub struct ServerPolicy {
    accepted: Vec<String>,
}

impl ServerPolicy {
    pub fn for_this_relay() -> Self {
        let mut candidates = Vec::new();
        if let Some(image) = std::env::current_exe()
            .ok()
            .and_then(|relay| installation_image(&relay))
        {
            candidates.push(image);
        }
        #[cfg(feature = "internal-fixtures")]
        {
            let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
            for folder in ["node_modules", "apps/desktop/node_modules"] {
                candidates.push(root.join(folder).join("electron/dist/electron.exe"));
            }
            if let Some(image) = std::env::var_os(TEST_SERVER_IMAGE_VARIABLE) {
                let image = PathBuf::from(image);
                if image.is_absolute() {
                    candidates.push(image);
                }
            }
        }
        Self::from_candidates(candidates)
    }

    pub fn from_candidates(candidates: impl IntoIterator<Item = PathBuf>) -> Self {
        Self {
            accepted: candidates
                .into_iter()
                .filter_map(|candidate| canonical_key(&candidate))
                .collect(),
        }
    }

    pub fn accepts(&self, image: &Path) -> bool {
        canonical_key(image).is_some_and(|image| self.accepted.contains(&image))
    }

    pub fn is_empty(&self) -> bool {
        self.accepted.is_empty()
    }
}

pub fn installation_image(relay: &Path) -> Option<PathBuf> {
    let native = relay.parent()?;
    let resources = native.parent()?;
    let application = resources.parent()?;
    if !matches!(native.components().next_back(), Some(Component::Normal(_)))
        || !matches!(
            resources.components().next_back(),
            Some(Component::Normal(_))
        )
    {
        return None;
    }
    Some(application.join(DESKTOP_IMAGE))
}

fn canonical_key(path: &Path) -> Option<String> {
    let canonical = std::fs::canonicalize(path).ok()?;
    if !canonical.is_file() {
        return None;
    }
    Some(canonical.to_str()?.to_lowercase())
}
