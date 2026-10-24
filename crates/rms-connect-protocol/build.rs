fn main() {
    let protoc = protoc_bin_vendored::protoc_bin_path().expect("vendored protoc is available");
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc);
    config
        .compile_protos(
            &["../../proto/rmside/connect/v1/connect.proto"],
            &["../../proto"],
        )
        .expect("rmside.connect.v1 Protobuf contract compiles");
    println!("cargo:rerun-if-changed=../../proto/rmside/connect/v1/connect.proto");
}
