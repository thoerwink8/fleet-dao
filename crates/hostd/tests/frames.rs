// Round-trip against the frames exported by packages/harness-contract (frames/): every sample must be accepted and
// written back unchanged, every invalid sample must be refused. The TypeScript side runs the same check on the
// same directory (packages/harness-contract/test/hostd-frames.test.ts).
use std::fs;
use std::path::PathBuf;

use hostd::frames::{parse_frame, to_line, PROTOCOL_VERSION};

fn frames_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/harness-contract/frames")
}

fn files(sub: &str) -> Vec<(String, String)> {
    let mut out: Vec<_> = fs::read_dir(frames_dir().join(sub))
        .unwrap_or_else(|e| panic!("frames/{sub} missing: {e}"))
        .map(|e| {
            let p = e.unwrap().path();
            (
                p.file_name().unwrap().to_string_lossy().into_owned(),
                fs::read_to_string(&p).unwrap().trim().to_string(),
            )
        })
        .collect();
    out.sort();
    out
}

#[test]
fn every_sample_frame_is_accepted_and_written_back_unchanged() {
    let samples = files("samples");
    assert!(
        samples.len() >= 20,
        "samples went missing: {}",
        samples.len()
    );
    for (name, text) in samples {
        let frame = parse_frame(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
        let back: serde_json::Value = serde_json::from_str(&to_line(&frame)).unwrap();
        let original: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(back, original, "{name}");
    }
}

#[test]
fn every_invalid_sample_is_refused() {
    let invalid = files("invalid");
    assert!(invalid.len() >= 5, "invalid samples went missing");
    for (name, text) in invalid {
        assert!(parse_frame(&text).is_err(), "{name} was accepted");
    }
}

#[test]
fn the_schema_and_the_handshake_sample_name_the_same_protocol_version() {
    let schema: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(frames_dir().join("schema.json")).unwrap())
            .unwrap();
    assert_eq!(schema["x-protocol"], PROTOCOL_VERSION);
    let hello = parse_frame(
        &files("samples")
            .iter()
            .find(|(n, _)| n == "hello-req.json")
            .unwrap()
            .1,
    )
    .unwrap();
    assert!(matches!(
        hello,
        hostd::frames::Frame::Hello { protocol, .. } if protocol == PROTOCOL_VERSION
    ));
}
