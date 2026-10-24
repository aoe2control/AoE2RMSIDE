use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    let manifest_directory =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("Cargo sets CARGO_MANIFEST_DIR"));
    let root = manifest_directory
        .join("..")
        .join("..")
        .canonicalize()
        .expect("the repository root exists");
    let connector = root.join("connector");
    let manifest_path = connector.join("catalog.json");
    let manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(&manifest_path).expect("connector/catalog.json is readable"),
    )
    .expect("connector/catalog.json is JSON");
    let files = manifest["files"]
        .as_array()
        .expect("connector/catalog.json lists its files");

    let mut code = String::new();
    writeln!(
        code,
        "pub(crate) static MANIFEST: &[u8] = include_bytes!({});",
        literal(&manifest_path)
    )
    .unwrap();
    code.push_str("pub(crate) static FILES: &[(&str, &[u8])] = &[\n");
    rerun(&manifest_path);
    for file in files {
        let path = file.as_str().expect("catalog paths are strings");
        assert!(
            !path.is_empty()
                && path.len() <= 96
                && path.split('/').all(|segment| {
                    !segment.is_empty()
                        && segment != "."
                        && segment != ".."
                        && segment.bytes().all(|byte| {
                            byte.is_ascii_lowercase()
                                || byte.is_ascii_digit()
                                || matches!(byte, b'.' | b'_' | b'-')
                        })
                }),
            "catalog path {path:?} is not canonical"
        );
        let source = path
            .split('/')
            .fold(connector.clone(), |folder, segment| folder.join(segment));
        rerun(&source);
        writeln!(
            code,
            "    ({path:?}, include_bytes!({})),",
            literal(&source)
        )
        .unwrap();
    }
    code.push_str("];\n");

    let package_path = root.join("apps").join("desktop").join("package.json");
    rerun(&package_path);
    let package: serde_json::Value = serde_json::from_slice(
        &fs::read(&package_path).expect("apps/desktop/package.json is readable"),
    )
    .expect("apps/desktop/package.json is JSON");
    let version = package["version"]
        .as_str()
        .expect("the desktop package has a version");
    assert!(
        !version.is_empty() && version.len() <= 64 && version.bytes().all(|b| b.is_ascii_graphic()),
        "the desktop version {version:?} is not a product version"
    );
    writeln!(
        code,
        "pub(crate) const PRODUCT_VERSION: &str = {version:?};"
    )
    .unwrap();

    let output =
        PathBuf::from(env::var("OUT_DIR").expect("Cargo sets OUT_DIR")).join("embedded.rs");
    fs::write(output, code).expect("the embedded catalog source is written");
}

fn literal(path: &Path) -> String {
    format!("{:?}", path.to_str().expect("the repository path is UTF-8"))
}

fn rerun(path: &Path) {
    println!("cargo:rerun-if-changed={}", path.display());
}
