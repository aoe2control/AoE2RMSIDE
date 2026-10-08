fn main() {
    let protoc = protoc_bin_vendored::protoc_bin_path().expect("vendored protoc is available");
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc);
    config.btree_map([
        ".rmside.v1.StructuredError.details",
        ".rmside.v1.BehaviorProfileDescriptor.capabilities",
        ".rmside.v1.GenerationResponse.metrics",
    ]);
    config
        .compile_protos(&["../../proto/rmside/v1/rmside.proto"], &["../../proto"])
        .expect("rmside.v1 Protobuf contract compiles");
    println!("cargo:rerun-if-changed=../../proto/rmside/v1/rmside.proto");
}
