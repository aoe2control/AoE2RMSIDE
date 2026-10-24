use sha2::{Digest, Sha256};

use crate::{NONCE_BYTES, PROOF_BYTES, PROTOCOL_MAJOR};

pub const KEY_BYTES: usize = 32;
pub const KEY_FILE_RELATIVE_PATH: &str = r"mcp\connector-key";
pub const KEY_ID_HEX_DIGITS: usize = 16;

const PIPE_LABEL: &[u8] = b"rmside-connect-pipe";
const SERVER_LABEL: &[u8] = b"rmside-connect-server";
const CLIENT_LABEL: &[u8] = b"rmside-connect-client";
const HMAC_BLOCK_BYTES: usize = 64;

pub fn hmac_sha256(key: &[u8], message_parts: &[&[u8]]) -> [u8; 32] {
    let mut block = [0_u8; HMAC_BLOCK_BYTES];
    if key.len() > HMAC_BLOCK_BYTES {
        let digest: [u8; 32] = Sha256::digest(key).into();
        block[..digest.len()].copy_from_slice(&digest);
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    for part in message_parts {
        inner.update(part);
    }
    let inner: [u8; 32] = inner.finalize().into();
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner);
    outer.finalize().into()
}

pub fn key_id(key: &[u8; KEY_BYTES]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(PIPE_LABEL);
    hasher.update(key);
    let digest: [u8; 32] = hasher.finalize().into();
    lower_hex(&digest[..KEY_ID_HEX_DIGITS / 2])
}

pub fn pipe_name(key: &[u8; KEY_BYTES]) -> String {
    format!(r"\\.\pipe\AoE2RMSIDE-MCP-{PROTOCOL_MAJOR}-{}", key_id(key))
}

pub fn server_proof(
    key: &[u8; KEY_BYTES],
    client_nonce: &[u8; NONCE_BYTES],
    server_nonce: &[u8; NONCE_BYTES],
) -> [u8; PROOF_BYTES] {
    hmac_sha256(key, &[SERVER_LABEL, client_nonce, server_nonce])
}

pub fn client_proof(
    key: &[u8; KEY_BYTES],
    server_nonce: &[u8; NONCE_BYTES],
    client_nonce: &[u8; NONCE_BYTES],
) -> [u8; PROOF_BYTES] {
    hmac_sha256(key, &[CLIENT_LABEL, server_nonce, client_nonce])
}

pub fn proof_matches(received: &[u8], expected: &[u8; PROOF_BYTES]) -> bool {
    if received.len() != PROOF_BYTES {
        return false;
    }
    received
        .iter()
        .zip(expected)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

pub(crate) fn lower_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(DIGITS[usize::from(byte >> 4)] as char);
        text.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    text
}
